require('dotenv').config();
const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton, Permissions } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const mongoose = require('mongoose');

const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.GUILD_PRESENCES
    ]
});

const guildSettingsSchema = new mongoose.Schema({
    guildId: String,
    roleId: String,
    messageId: String,
    channelId: String,
    members: [{
        memberId: String,
        onlineTime: { type: Number, default: 0 },
        idleTime: { type: Number, default: 0 },
        dndTime: { type: Number, default: 0 },
        offlineTime: { type: Number, default: 0 },
        lastStatus: { type: String, default: 'offline' },
        lastUpdate: { type: Date, default: Date.now }
    }]
});

const GuildSettings = mongoose.model('GuildSettings', guildSettingsSchema);

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');
    await refreshStatusEmbeds();
    setInterval(refreshStatusEmbeds, 60000); // Refresh every minute
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    if (interaction.isCommand()) {
        const { commandName, options, guild, channel, member } = interaction;

        if (commandName === 'setrole') {
            // Check if user has MANAGE_ROLES and MANAGE_MESSAGES permissions
            if (!member.permissions.has(Permissions.FLAGS.MANAGE_ROLES)) {
                return interaction.reply({
                    content: 'You need to have `Manage Roles` permissions to use this command.',
                    ephemeral: true
                });
            }

            const role = options.getRole('role');
            if (!role) return interaction.reply('Role not found!');

            let guildSetting = await GuildSettings.findOne({ guildId: guild.id });
            if (!guildSetting) {
                guildSetting = new GuildSettings({
                    guildId: guild.id,
                    roleId: role.id,
                    channelId: channel.id
                });
            } else {
                guildSetting.roleId = role.id;
                guildSetting.channelId = channel.id;
            }

            const embedMessage = await channel.send({
                embeds: [createStatusEmbed(role, guildSetting.members, 0)],
                components: [createActionRow(0, 10, guildSetting.members.length)]
            });
            guildSetting.messageId = embedMessage.id;
            await guildSetting.save();

            return interaction.reply('Role set and status message created/updated!');
        } else if (commandName === 'disable') {
            // Check if user has MANAGE_ROLES and MANAGE_MESSAGES permissions
            if (!member.permissions.has(Permissions.FLAGS.MANAGE_MESSAGES)) {
                return interaction.reply({
                    content: 'You need to have `Manage Messages` permissions to use this command.',
                    ephemeral: true
                });
            }

            await GuildSettings.findOneAndDelete({ guildId: guild.id });
            return interaction.reply('Status tracking disabled for this server.');
        } else if (commandName === 'help') {
            const helpEmbed = new MessageEmbed()
                .setTitle('Help')
                .setColor('BLUE')
                .setDescription('Here are the available commands:')
                .addField('/setrole', 'Set a role to track member statuses')
                .addField('/disable', 'Disable status tracking for this server')
                .addField('/help', 'Show this help message')
                .addField('/restartstaff', 'Reset the tracked time for all staff members')
                .addField('/ping', 'Show the bot and database ping')
                .addField('/showstaff', 'Show the list of staff members being tracked');

            return interaction.reply({ embeds: [helpEmbed] });
        } else if (commandName === 'restartstaff') {
            // Check if user has MANAGE_ROLES and MANAGE_MESSAGES permissions
            if (!member.permissions.has(Permissions.FLAGS.MANAGE_MESSAGES)) {
                return interaction.reply({
                    content: 'You need to have `Manage Messages` permissions to use this command.',
                    ephemeral: true
                });
            }

            const guildSetting = await GuildSettings.findOne({ guildId: guild.id });
            if (!guildSetting) return interaction.reply('No tracking data found for this server.');

            guildSetting.members = guildSetting.members.map(member => ({
                memberId: member.memberId,
                onlineTime: 0,
                idleTime: 0,
                dndTime: 0,
                offlineTime: 0,
                lastStatus: member.lastStatus,
                lastUpdate: new Date()
            }));
            await guildSetting.save();

            return interaction.reply('Staff time has been reset.');
        } else if (commandName === 'ping') {
            const botPing = client.ws.ping;
            const mongoPing = await mongoose.connection.db.admin().ping();

            const pingEmbed = new MessageEmbed()
                .setTitle('Pong!')
                .setColor('GREEN')
                .addField('Bot Ping', `${botPing}ms`, true)
                .addField('MongoDB Ping', `${mongoPing.ok ? 'Connected' : 'Disconnected'}`, true);

            return interaction.reply({ embeds: [pingEmbed] });
        } else if (commandName === 'showstaff') {
            const guildSetting = await GuildSettings.findOne({ guildId: guild.id });
            if (!guildSetting) return interaction.reply('No tracking data found for this server.');

            const role = guild.roles.cache.get(guildSetting.roleId);
            if (!role) return interaction.reply('Role not found!');

            const staffList = role.members.map(member => member.toString()).join('\n') || 'No staff members found.';

            const staffEmbed = new MessageEmbed()
                .setTitle(`Staff members in role: ${role.name}`)
                .setColor('BLUE')
                .setDescription(staffList);

            return interaction.reply({ embeds: [staffEmbed] });
        }
    } else if (interaction.isButton()) {
        const [action, pageIndex] = interaction.customId.split('_');
        const guildSetting = await GuildSettings.findOne({ guildId: interaction.guild.id });
        if (!guildSetting) return interaction.reply('No tracking data found for this server.');

        const role = interaction.guild.roles.cache.get(guildSetting.roleId);
        if (!role) return interaction.reply('Role not found!');

        try {
            const message = await interaction.channel.messages.fetch(guildSetting.messageId);
            const embed = createStatusEmbed(role, guildSetting.members, parseInt(pageIndex, 10));
            await message.edit({ embeds: [embed], components: [createActionRow(parseInt(pageIndex, 10), 10, guildSetting.members.length)] });
            return interaction.reply({ content: 'Status refreshed!', ephemeral: true });
        } catch (err) {
            console.error(`Failed to update status message in guild ${interaction.guild.id}:`, err);
            return interaction.reply('Failed to refresh status.');
        }
    }
});


client.on('presenceUpdate', async (oldPresence, newPresence) => {
    const guildSetting = await GuildSettings.findOne({ guildId: newPresence.guild.id });
    if (!guildSetting) return;

    const member = guildSetting.members.find(m => m.memberId === newPresence.member.id);
    if (!member) {
        guildSetting.members.push({
            memberId: newPresence.member.id,
            lastStatus: newPresence.status,
            lastUpdate: new Date()
        });
    } else {
        const now = new Date();
        const diff = (now - new Date(member.lastUpdate)) / 1000; // difference in seconds

        switch (member.lastStatus) {
            case 'online':
                member.onlineTime += diff;
                break;
            case 'idle':
                member.idleTime += diff;
                break;
            case 'dnd':
                member.dndTime += diff;
                break;
            case 'offline':
                member.offlineTime += diff;
                break;
        }

        member.lastStatus = newPresence.status;
        member.lastUpdate = now;
    }

    await guildSetting.save();
});

async function refreshStatusEmbeds() {
    const guildSettings = await GuildSettings.find();
    for (const setting of guildSettings) {
        const guild = client.guilds.cache.get(setting.guildId);
        if (!guild) continue;

        const role = guild.roles.cache.get(setting.roleId);
        if (!role) continue;

        const channel = guild.channels.cache.get(setting.channelId);
        if (!channel) continue;

        try {
            const message = await channel.messages.fetch(setting.messageId);
            const embed = createStatusEmbed(role, setting.members, 0);
            await message.edit({ embeds: [embed], components: [createActionRow(0, 10, setting.members.length)] });
        } catch (err) {
            console.error(`Failed to update status message in guild ${guild.id}:`, err);
        }
    }
}

function createStatusEmbed(role, memberData, pageIndex) {
    const membersPerPage = 10;
    const start = pageIndex * membersPerPage;
    const end = start + membersPerPage;

    const embed = new MessageEmbed()
        .setTitle(`Status for role: ${role.name}`)
        .setColor('BLUE')
        .setTimestamp()
        .setFooter('Last updated');

    const members = role.members.map(member => {
        const data = memberData.find(m => m.memberId === member.id);
        if (!data) return `${member}: No data available`;

        return `${member}: \nOnline: ${formatTime(data.onlineTime)} \nIdle: ${formatTime(data.idleTime)} \nDND: ${formatTime(data.dndTime)} \nOffline: ${formatTime(data.offlineTime)}`;
    });

    embed.setDescription(members.slice(start, end).join('\n\n') || 'None');

    return embed;
}

function createActionRow(pageIndex, membersPerPage, totalMembers) {
    const row = new MessageActionRow()
        .addComponents(
            new MessageButton()
                .setCustomId(`previous_${pageIndex - 1}`)
                .setLabel('Previous')
                .setStyle('SECONDARY')
                .setDisabled(pageIndex === 0),
            new MessageButton()
                .setCustomId('refresh_0')
                .setLabel('Refresh')
                .setStyle('PRIMARY'),
            new MessageButton()
                .setCustomId(`next_${pageIndex + 1}`)
                .setLabel('Next')
                .setStyle('SECONDARY')
                .setDisabled((pageIndex + 1) * membersPerPage >= totalMembers)
        );
    return row;
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${seconds}s`;
}

client.login(process.env.DISCORD_TOKEN);

// Register slash commands
(async () => {
    const commands = [
        {
            name: 'setrole',
            description: 'Set a role to track member statuses',
            options: [
                {
                    type: 8,
                    name: 'role',
                    description: 'The role to track',
                    required: true,
                },
            ],
        },
        {
            name: 'disable',
            description: 'Disable status tracking for this server',
        },
        {
            name: 'help',
            description: 'Show the help message',
        },
        {
            name: 'restartstaff',
            description: 'Reset the tracked time for all staff members',
        },
        {
            name: 'ping',
            description: 'Show the bot and database ping',
        },
        {
            name: 'showstaff',
            description: 'Show the list of staff members being tracked',
        }
    ];

    const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();
