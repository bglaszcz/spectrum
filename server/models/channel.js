// @flow
const { db } = require('./db');
// $FlowFixMe
import { UserError } from 'graphql-errors';

const getChannelsByCommunity = (
  communityId: string
): Promise<Array<Object>> => {
  return db
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .run();
};

/*
  If a non-user is viewing a community page, they should only see threads
  from public channels. We use this function to return an array of channelIds
  that are public, and pass them into a getThreads function
*/
const getPublicChannelsByCommunity = (
  communityId: string
): Promise<Array<Object>> => {
  return db
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .filter({ isPrivate: false })
    .run();
};

/*
  If a user is viewing a community, they should only see threads from the
  channels they are members of in order to avoid accidentally seeing threads
  from a private channel.

  This function returns an array of objects with the field 'id' that corresponds
  to a channelId. This array of IDs will be passed into a threads method which
  will only return threads in those channels
*/
const getChannelsByUserAndCommunity = (
  communityId: string,
  userId: string
): Promise<Array<Object>> => {
  return (
    db
      .table('channels')
      .getAll(communityId, { index: 'communityId' })
      .eqJoin('id', db.table('usersChannels'), { index: 'channelId' })
      // get channels where the user is a member OR the channel is public
      .filter(row =>
        row('right')('isMember')
          .eq(true)
          .and(row('right')('userId').eq(userId))
          .or(row('left')('isPrivate').eq(false))
      )
      .without({ right: 'id' })
      .zip()
      .pluck('id')
      .distinct()
      .run()
  );
};

const getChannelsByUser = (userId: string): Promise<Array<Object>> => {
  return (
    db
      .table('usersChannels')
      // get all the user's channels
      .getAll(userId, { index: 'userId' })
      // get the channel objects for each channel
      .eqJoin('channelId', db.table('channels'))
      // get rid of unnecessary info from the usersChannels object on the left
      .without({ left: ['id', 'channelId', 'userId', 'createdAt'] })
      // zip the tables
      .zip()
      // ensure we don't return any deleted channels
      .filter(channel => db.not(channel.hasFields('deletedAt')))
      // sort by channel creation date
      .orderBy('createdAt')
      .run()
  );
};

const getChannelBySlug = (
  channelSlug: string,
  communitySlug: string
): Promise<Object> => {
  return db
    .table('channels')
    .eqJoin('communityId', db.table('communities'))
    .filter({
      left: {
        slug: channelSlug,
      },
      right: {
        slug: communitySlug,
      },
    })
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .run()
    .then(result => {
      if (result && result[0]) {
        return result[0].left;
      }
    });
};

type GetChannelByIdArgs = {
  id: string,
};

type GetChannelBySlugArgs = {
  slug: string,
  communitySlug: string,
};

export type GetChannelArgs = GetChannelByIdArgs | GetChannelBySlugArgs;

const getChannels = (channelIds: Array<string>): Promise<Array<Object>> => {
  return db
    .table('channels')
    .getAll(...channelIds)
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .run();
};

const getChannelMetaData = (channelId: string): Promise<Array<number>> => {
  const getThreadCount = db
    .table('threads')
    .getAll(channelId, { index: 'channelId' })
    .count()
    .run();

  const getMemberCount = db
    .table('usersChannels')
    .getAll(channelId, { index: 'channelId' })
    .filter({ isBlocked: false, isPending: false })
    .count()
    .run();

  return Promise.all([getThreadCount, getMemberCount]);
};

export type CreateChannelArguments = {
  input: {
    communityId: string,
    name: string,
    description: string,
    slug: string,
    isPrivate: Boolean,
  },
};

export type EditChannelArguments = {
  input: {
    channelId: string,
    name: string,
    description: string,
    slug: string,
    isPrivate: Boolean,
  },
};

const createChannel = ({
  input: { communityId, name, slug, description, isPrivate },
}: CreateChannelArguments): Promise<Object> => {
  return db
    .table('channels')
    .insert(
      {
        communityId,
        createdAt: new Date(),
        name,
        description,
        slug,
        isPrivate,
      },
      { returnChanges: true }
    )
    .run()
    .then(result => result.changes[0].new_val);
};

const createGeneralChannel = (communityId: string): Promise<Object> => {
  return createChannel({
    input: {
      name: 'General',
      slug: 'general',
      description: 'General Chatter',
      communityId,
      isPrivate: false,
      isDefault: true,
    },
  });
};

const editChannel = ({
  input: { name, slug, description, isPrivate, channelId },
}: EditChannelArguments): Object => {
  return db
    .table('channels')
    .get(channelId)
    .run()
    .then(result => {
      return Object.assign({}, result, {
        name,
        description,
        slug,
        isPrivate,
      });
    })
    .then(obj => {
      return db
        .table('channels')
        .get(channelId)
        .update({ ...obj }, { returnChanges: 'always' })
        .run()
        .then(result => {
          // if an update happened
          if (result.replaced === 1) {
            return result.changes[0].new_val;
          }

          // an update was triggered from the client, but no data was changed
          if (result.unchanged === 1) {
            return result.changes[0].old_val;
          }
        });
    });
};

/*
  We delete data non-destructively, meaning the record does not get cleared
  from the db.
*/
const deleteChannel = (channelId: string): Promise<Boolean> => {
  return db
    .table('channels')
    .get(channelId)
    .update(
      {
        deletedAt: new Date(),
        slug: db.uuid(),
      },
      {
        returnChanges: true,
        nonAtomic: true,
      }
    )
    .run()
    .then(result => {
      // update was successful
      if (result.replaced >= 1) {
        return true;
      }

      // update failed
      return new UserError(
        "Something went wrong and we weren't able to delete this channel."
      );
    });
};

const getTopChannels = (amount: number): Array<Object> => {
  return db.table('channels').orderBy(db.desc('members')).limit(amount).run();
};

const getChannelMemberCount = (channelId: string): number => {
  return db.table('channels').get(channelId)('members').count().run();
};

module.exports = {
  getChannelBySlug,
  getChannelMetaData,
  getChannelsByUser,
  getChannelsByCommunity,
  getPublicChannelsByCommunity,
  getChannelsByUserAndCommunity,
  createChannel,
  createGeneralChannel,
  editChannel,
  deleteChannel,
  getTopChannels,
  getChannelMemberCount,
  getChannels,
};