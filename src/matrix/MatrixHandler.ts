import * as log4js from 'log4js';
import Channel from '../Channel';
import { User } from '../entities/User';
import { Post } from '../entities/Post';
import { Mapping } from '../entities/Mapping';
import { Client, ClientError } from '../mattermost/Client';
import {
    joinMattermostChannel,
    leaveMattermostChannel,
    getMatrixIntegrationTeam
} from '../mattermost/Utils';
import { sendNotice, NoticeType } from './Utils'
import { handlePostError, none } from '../utils/Functions';
import { matrixToMattermost } from '../utils/Formatting';
import { MatrixEvent } from '../Interfaces';
import * as FormData from 'form-data';
import { getLogger } from '../Logging';
import main from '../Main';
import { config } from '../Config';
import { MatrixClient, Membership } from './MatrixClient';
import * as emoji from 'node-emoji';


interface RoomMember {
    type: string;
    membership: string;
    displayName: string;
    userId: string;
}


const myLogger: log4js.Logger = getLogger('MatrixHandler');



interface Metadata {
    edits?: string;
    root_id?: string;
}


async function uploadFile(
    this: Channel,
    user: User,
    event: MatrixEvent,
    metadata: Metadata,
) {
    const main = this.main;
    const client = main.botClient;
    const mxc: string = event.content.url;
    const parts = mxc.split('/');

    const body = await client.download(parts[2], parts[3], event.content.body);

    if (!body) {
        throw new Error(`Downloaded empty file: ${mxc}`);
    }

    const form = new FormData();
    form.append('files', body, {
        filename: event.content.body,
        contentType: event.content.info?.mimetype,
    });
    form.append('channel_id', this.mattermostChannel);

    const fileInfos = await user.client.post('/files', form);
    const fileid = fileInfos.file_infos[0].id;
    const post = await user.client.post('/posts', {
        channel_id: this.mattermostChannel,
        message: event.content.body,
        root_id: metadata.root_id,
        file_ids: [fileid],
    });
    await Post.create({
        postid: post.id,
        eventid: event.event_id,
        rootid: metadata.root_id || post.id,
    }).save();
}

const MatrixMessageHandlers = {
    'm.text': async function (
        this: Channel,
        user: User,
        event: MatrixEvent,
        metadata: Metadata,
    ) {
        if (metadata.edits) {
            try {
                await user.client.put(`/posts/${metadata.edits}/patch`, {
                    message: await matrixToMattermost(
                        event.content['m.new_content'],
                    ),
                });
            } catch (e) {
                await handlePostError(this.main.dataSource, e, metadata.edits);
            }
            return;
        }
        const message = await matrixToMattermost(event.content);
        let post: any = undefined;
        const info = await user.client.post(
            '/posts',
            {
                channel_id: this.mattermostChannel,
                message: message,
                root_id: metadata.root_id,
            },
            false,
            false,
        );
        if (info.status === 201) {
            post = info.data;
        } else {
            const user_id = user.mattermost_userid;
            try {
                const channel = await this.main.client.get(
                    `/channels/${this.mattermostChannel}`,
                );
                // Check if user is team member and create if the user not in team
                const teamMember = await this.main.client.get(
                    `/teams/${channel.team_id}/members/${user_id}`,
                    undefined,
                    false,
                    false,
                );
                if (teamMember.status === 404) {
                    await this.main.client.post(
                        `/teams/${channel.team_id}/members`,
                        {
                            team_id: channel.team_id,
                            user_id: user_id,
                        },
                    );
                }
                await this.main.client.post(`/channels/${channel.id}/members`, {
                    user_id: user_id,
                    post_root_id: metadata.root_id,
                });
                post = await user.client.post('/posts', {
                    channel_id: this.mattermostChannel,
                    message: message,
                    root_id: metadata.root_id,
                });
            } catch (error) {
                myLogger.error(
                    'Error on m.text event handler: %s',
                    error.message,
                );
                return;
            }
        }

        await Post.create({
            postid: post.id,
            eventid: event.event_id,
            rootid: metadata.root_id || post.id,
        }).save();
    },
    'm.emote': async function (
        this: Channel,
        user: User,
        event: MatrixEvent,
        metadata: Metadata,
    ) {
        if (metadata.edits) {
            const content = await matrixToMattermost(
                event.content['m.new_content'],
            );
            try {
                await user.client.put(`/posts/${metadata.edits}/patch`, {
                    message: `*${content}*`,
                    props: {
                        message: content,
                    },
                });
            } catch (e) {
                await handlePostError(this.main.dataSource, e, metadata.edits);
            }

            return;
        }
        const content = await matrixToMattermost(event.content);
        await user.client.post('/commands/execute', {
            channel_id: this.mattermostChannel,
            team_id: await this.getTeam(),
            command: `/me ${content}`,
            root_id: metadata.root_id,
        });
        const posts = await user.client.get(
            `/channels/${this.mattermostChannel}/posts`,
        );
        for (const postid of posts.order) {
            const post = posts.posts[postid];
            if (post.type === 'me' && post.props.message === content) {
                await Post.create({
                    postid: postid,
                    eventid: event.event_id,
                    rootid: metadata.root_id || post.id,
                }).save();
                return;
            }
        }
        myLogger.info(`Cannot find post for ${content}`);
    },
    'm.file': uploadFile,
    'm.image': uploadFile,
    'm.audio': uploadFile,
    'm.video': uploadFile,
};

const MatrixMembershipHandler = {
    invite: none,
    knock: none,
    join: async function (this: Channel, userid: string): Promise<void> {
        if (this.main.skipMatrixUser(userid)) {
            return;
        }

        const channel = await this.main.client.get(
            `/channels/${this.mattermostChannel}`,
        );
        if (channel.type != 'G') {
            const user = await this.main.matrixUserStore.getOrCreate(
                userid,
                true,
            );
            await joinMattermostChannel(this, user);
        }
    },
    leave: async function (this: Channel, userid: string) {
        const user = await this.main.matrixUserStore.get(userid);
        if (user === undefined) {
            myLogger.info(`Found untracked matrix user ${userid}`);
            return;
        }
        const channel = await this.main.client.get(
            `/channels/${this.mattermostChannel}`,
        );
        if (channel.type != 'G') {
            await leaveMattermostChannel(
                this.main.client,
                this.mattermostChannel,
                user.mattermost_userid,
            );

            // Check if we have left all channels in the team. If so, leave the
            // team. This is useful because this is the only way to leave Town
            // Square.
            const team = await this.getTeam();
            const channels = this.main.channelsByTeam.get(team) as Channel[];

            const joined = await Promise.all(
                channels.map(async channel => {
                    const members = await this.main.botClient.getRoomMembers(
                        channel.matrixRoom,
                    );
                    return Object.keys(members.joined).includes(
                        user.matrix_userid,
                    );
                }),
            );

            if (!joined.some(x => x)) {
                await user.client.delete(
                    `/teams/${team}/members/${user.mattermost_userid}`,
                );
            }
        }
    },
    ban: async function (this: Channel, userid: string): Promise<void> {
        await MatrixMembershipHandler.leave.bind(this)(userid);
    },
};

const MatrixHandlers = {
    'm.room.message': async function (
        this: Channel,
        event: MatrixEvent,
    ): Promise<any> {
        const content = event.content;
        const user = await this.main.matrixUserStore.get(event.sender);
        if (user === undefined) {
            myLogger.info(
                `Received message from untracked matrix user ${event.sender}`,
            );
            return undefined;
        }

        const relatesTo = event.content['m.relates_to'];
        const metadata: Metadata = {};
        if (relatesTo !== undefined) {
            if (relatesTo.rel_type === 'm.replace') {
                const post = await Post.findOne({
                    //eventid: relatesTo.event_id,
                    where: { eventid: relatesTo.event_id },
                });
                if (post !== undefined) {
                    metadata.edits = post?.postid;
                }
            } else if (relatesTo['m.in_reply_to'] !== undefined) {
                const post = await Post.findOne({
                    //eventid: relatesTo['m.in_reply_to'].event_id,
                    where: { eventid: relatesTo['m.in_reply_to'].event_id },
                });
                if (post !== null) {
                    try {
                        const props = await user.client.get(
                            `/posts/${post.postid}`,
                        );
                        metadata.root_id = props.root_id || post?.postid;
                    } catch (e) {
                        if (post?.postid != null)
                            await handlePostError(
                                this.main.dataSource,
                                e,
                                post.postid,
                            );
                        else {
                            throw e;
                        }
                    }
                }
            }
        }
        const msgType: string = content.msgtype || 'not found';
        let handler = MatrixMessageHandlers[msgType];
        if (handler === undefined) {
            handler = MatrixMessageHandlers['m.text'];
        }
        return await handler.bind(this)(user, event, metadata);
    },

    'm.reaction': async function (
        this: Channel,
        event: MatrixEvent,
    ): Promise<any> {
        const content = event.content;
        const user = await this.main.matrixUserStore.get(event.sender);
        if (user === undefined) {
            myLogger.info(
                `Received message from untracked matrix user ${event.sender}`,
            );
            return undefined;
        }
        const relatesTo = content['m.relates_to'];
        const eventId = relatesTo.event_id;
        let emojiName = emoji.unemojify(relatesTo.key);
        if (!emojiName) {
            emojiName = '+1';
        } else {
            emojiName = emojiName.substring(1, emojiName.length - 1);
        }
        const post = await Post.findOne({
            //eventid: relatesTo.event_id,
            where: { eventid: eventId },
        });
        await user.client.post(
            '/reactions',

            {
                user_id: user.mattermost_userid,
                post_id: post.postid,
                emoji_name: emojiName,
            },
        );
    },
    'm.room.member': async function (
        this: Channel,
        event: MatrixEvent,
    ): Promise<void> {
        const findMapping = await Mapping.findOne({
            where: { matrix_room_id: event.room_id },
        });

        if (findMapping) {
            const user = await this.main.matrixUserStore.get(event.sender);
           
            const mmUser = await User.findOne({
                where: { matrix_userid: event.state_key }
            })
           // const team = await getMatrixIntegrationTeam(this.main.client, mmUser.mattermost_userid)

            if (!findMapping.is_direct) {
                await this.main.client.post(`/channels/${findMapping.mattermost_channel_id}/members`,
                    {
                        user_id: mmUser.mattermost_userid

                    }
                )
            } else {
                await sendNotice('Info',this.main.botClient,event.room_id,`Can not add members to this channel type.`)
            }

        } else {

            const membership: string = event.content.membership || 'not found';
            const handler = MatrixMembershipHandler[membership];
            if (handler === undefined) {
                myLogger.warn(
                    `Invalid membership state: ${event.content.membership}`,
                );
                return;
            }
            await handler.bind(this)(event.state_key);
        }
    },
    'm.room.redaction': async function (
        this: Channel,
        event: MatrixEvent,
    ): Promise<void> {
        const botid = this.main.botClient.getUserId();
        // Matrix loop detection doesn't catch redactions.
        if (event.sender === botid) {
            return;
        }
        const r: any = event['redacts'];
        const redacts: string = r || '';
        const post = await Post.findOne({
            //eventid: event.redacts as string,
            where: { eventid: redacts },
        });
        if (post === null) {
            return;
        }

        // Delete in database before sending the query, so that the
        // Mattermost event doesn't get processed.
        await Post.removeAll(this.main.dataSource, post.postid);

        // The post might have been deleted already, either due to both
        // sides deleting simultaneously, or the message being deleted
        // while the bridge is down.
        try {
            await this.main.client.delete(`/posts/${post.postid}`);
        } catch (e) {
            if (
                !(
                    e instanceof ClientError &&
                    e.m.status_code === 403 &&
                    e.m.id === 'api.context.permissions.app_error'
                )
            ) {
                throw e;
            }
        }
    },
};

export const MatrixUnbridgedHandlers = {

    'm.room.member': async function (
        this: main,
        event: MatrixEvent,
    ): Promise<void> {
        const room_id = event.room_id;
        const displayName: string = event.content?.displayname || '';
        const botDisplayName = config().matrix_bot?.display_name;
        if (botDisplayName === displayName) {
            const info = await this.botClient.joinRoom(room_id);
            myLogger.debug(
                'Found bot client %s invite for room %s. Info=%s',
                botDisplayName,
                room_id,
                info,
            );
        } else {
            myLogger.debug(
                'Client %s invite request for room %s',
                event.state_key,
                room_id,
            );
            const remoteUser: User = await User.findOne({
                where: { matrix_userid: event.state_key },
            });
            if (remoteUser && !remoteUser.is_matrix_user) {
                const client: MatrixClient =
                    await this.mattermostUserStore.client(remoteUser);
                await client.joinRoom(room_id);
            }
        }
    },
    'm.room.message': async function (
        this: main,
        event: MatrixEvent,
    ): Promise<void> {
        const botDisplayName = config().matrix_bot?.display_name;
        const memberships: Membership[] = ['join', 'invite'];
        const roomMembers: RoomMember[] = [];
        let roomName = ''
        let canonicalAlias = ''
        const user = await this.matrixUserStore.get(event.sender);


        for (const membership of memberships) {
            const response = await this.botClient.getRoomMembers(
                event.room_id,
                membership,
            );
            for (const member of response.chunk) {
                roomMembers.push({
                    type: member.type,
                    displayName: member.content.displayname,
                    membership: member.content.membership,
                    userId: member.state_key,
                });
            }
        }


        const mmUsers: string[] = [];
        let localMembers: number = 0;

        for (const member of roomMembers) {
            if (member.displayName == botDisplayName) {
                mmUsers.push(config().mattermost_bot_userid);

            } else if (!this.skipMatrixUser(member.userId)) {
                const mmUser = await User.findOne({
                    where: { matrix_userid: member.userId },
                });
                if (mmUser) {
                    mmUsers.push(mmUser.mattermost_userid);

                    if (mmUser.is_matrix_user) localMembers++;
                }
            }
        }

        const states = await this.botClient.getRoomStateAll(event.room_id)

        for (const state of states) {
            switch (state.type) {
                case 'm.room.create':
                    break
                case 'm.room.name':
                    roomName = state.content.name
                    break
                case 'm.room.canonical_alias':
                    canonicalAlias = state.content.alias
                    break
                case 'm.room.member':

            }
        }
        const remoteUsers = mmUsers.length - localMembers - 1;
        if (remoteUsers < 1 || (!roomName && remoteUsers > 7)) {
            const message = `<strong>No mapping to Mattermost channel done</strong>. No remote users invited or to many users invited. Invited remote users=${remoteUsers}, local users=${localMembers}.`;

            await sendNotice('Warning', this.botClient, event.room_id, message)
            await this.botClient.leave(event.room_id);
            return;
        }


        if (roomName) {
            myLogger.debug("Creating federated private/public Room=%s", roomName)
            const channelName = roomName.replace(/\s+/g, '_').toLowerCase();
            const team = await getMatrixIntegrationTeam(this.client, user.mattermost_userid)
            const teamMembers: any[] = await this.client.get(`/teams/${team.id}/members`)

            const check = await this.client.get(`/teams/${team.id}/channels/name/${channelName}`, undefined, false, false)
            if (check.status === 200) {
                const message = `Channel with name ${channelName} exist in team ${team.name}. No mapping done`
                await sendNotice('Error', this.botClient, event.room_id, message)
                await this.botClient.leave(event.room_id);
                return
            }

            const channel = await user.client.post('/channels',

                {
                    team_id: team.id,
                    name: channelName,
                    display_name: roomName,
                    purpose: "Matrix integration",
                    header: user.matrix_displayname,
                    type: canonicalAlias ? 'O' : 'P'
                }
            )
            for (let mmUser of mmUsers) {
                if (mmUser !== user.mattermost_userid) {
                    const inTeam = teamMembers.find(member => { return member.user_id === mmUser })
                    if (!inTeam) {
                        await this.client.post(`/teams/${team.id}/members`,
                            {
                                user_id: mmUser,
                                team_id: team.id

                            }
                        )
                    }

                    await user.client.post(`/channels/${channel.id}/members`,
                        {
                            user_id: mmUser,
                        }
                    )

                }
            }
            this.doOneMapping(channel.id, event.room_id);

            const mapping = new Mapping();
            mapping.is_direct = false;
            mapping.is_private = !canonicalAlias;
            mapping.from_mattermost = false;
            mapping.matrix_room_id = event.room_id;
            mapping.mattermost_channel_id = channel.id;
            mapping.info = `Channel display name: ${channel.display_name}`;
            await mapping.save();
            const message = `Room mapped to Mattermost channel <strong>${channel.display_name} </strong> in team <strong>${team.name}</strong>`
            await sendNotice('Info', this.botClient, event.room_id, message)
            await this.redoMatrixEvent(event);
        }
        else {

            const channel = await user.client.post('/channels/group', mmUsers);
            const findMapping = await Mapping.findOne({
                where: { mattermost_channel_id: channel.id },
            });
            const roomExists: boolean = findMapping ? true : false;
            myLogger.info(
                'New direct message channel %s. Mapped to matrix room [%s]. Number of members=%d, Mapping exist=%s',
                channel.display_name,
                event.room_id,
                mmUsers.length,
                roomExists,
            );

            this.doOneMapping(channel.id, event.room_id);

            const mapping = new Mapping();
            mapping.is_direct = true;
            mapping.is_private = true;
            mapping.from_mattermost = false;
            mapping.matrix_room_id = event.room_id;
            mapping.mattermost_channel_id = channel.id;
            mapping.info = `Channel display name: ${channel.display_name}`;
            await mapping.save();
            try {
                await this.redoMatrixEvent(event);
                if (findMapping) {
                    const message = `Mapping to Mattermost channel <strong>${channel.display_name}</strong> no longer valid. Use new direct chat setup.`;
                    await sendNotice('Warning', this.botClient, findMapping.matrix_room_id, message)
                    await this.botClient.leave(findMapping.matrix_room_id);
                }
            } catch (err) {
                myLogger.warn(
                    'First message to %s channel %s fails. Error=%s',
                    channel.display_name,
                    err.message,
                );
            }
        }
    },
};

export default MatrixHandlers;
