const BaseDiscordModule = require("./base/BaseDiscordModule");
const { EventEmitter } = require("events");
const { escapeMarkdown: escape } = require("./Utils");
const { GuildModel } = require("./Database");

/**
 * # Logs Processor
 *
 * This module listening for guild events and sending logs messages to target channels.
 *
 * ## List of supported events
 *
 * + Joining
 * + Leaving
 * + Kicks (only with Audit Logs access)
 * + Bans (with executor and reason if Audit Logs access)
 * + Unbans (with executor and reason if Audit Logs access)
 *
 * @todo Message attachments for private logs.
 * @todo Message edits for private logs.
 * @todo Message deleting for private logs.
 */
class LogsProcessor extends BaseDiscordModule {
	/**
	 * Event emitter used for proxying DiscordJS events to logs related events.
	 * @type {module:events.EventEmitter.EventEmitter}
	 */
	#emitter = new EventEmitter();

	/**
	 * Initialize logs processor module.
	 * @return {Promise<LogsProcessor>}
	 */
	async initialize() {
		this.#proxyDiscordEvents();
		this.#handleLogEvents();
		return this;
	}

	/**
	 * Set up proxy from DiscordJS events to logs events.
	 */
	#proxyDiscordEvents() {
		this.client.on("guildMemberAdd", member => this.#emitter.emit("join", member));
		this.client.on("guildMemberRemove", member => this.#resolveMemberRemove(member));
		this.client.on("guildMemberUpdate", (prev, curr) => this.#resolveMemberUpdate(prev, curr));
		this.client.on("guildBanAdd", (guild, user) => this.#resolveBanManagementEvent("ban", guild, user));
		this.client.on("guildBanRemove", (guild, user) => this.#resolveBanManagementEvent("unban", guild, user));
	}

	/**
	 * Resolve member removing event. This method checking for audit logs to select which one event must be shown.
	 * @param {module:"discord.js".GuildMember} member Target member.
	 * @return {Promise<any>}
	 */
	async #resolveMemberRemove(member) {
		if (member.partial)
			await member.fetch();
		if (!member.guild.me.hasPermission("VIEW_AUDIT_LOG"))
			return this.#emitter.emit("left", member);
		const logs = await member.guild.fetchAuditLogs();
		const entry = logs.entries.find(
			entry => (["MEMBER_KICK", "MEMBER_BAN_ADD", "MEMBER_BAN_REMOVE"].includes(entry.action))
				&& (entry.targetType === "USER" && entry.target.id === member.id)
		);
		if (!entry)
			return this.#emitter.emit("left", member);
		if (entry.action === "MEMBER_KICK")
			return this.#emitter.emit("kick", member, entry);
	}

	/**
	 * Resolve ban/unban events with or without audit logs entries if available.
	 * @param {"ban"|"unban"} eventName Target event name.
	 * @param {module:"discord.js".Guild} guild Guild instance.
	 * @param {module:"discord.js".User} user User instance.
	 * @return {Promise<void>}
	 */
	async #resolveBanManagementEvent(eventName, guild, user) {
		if (!guild.me.hasPermission("VIEW_AUDIT_LOG"))
			return void this.#emitter.emit(eventName, guild, user);
		const logs = await guild.fetchAuditLogs({
			type: `MEMBER_BAN_${eventName === "ban" ? "ADD" : "REMOVE"}`
		});
		const entry = logs.entries.find(entry => entry.targetType === "USER" && entry.target.id === user.id);
		if (!entry)
			return void this.#emitter.emit(eventName, guild, user);
		this.#emitter.emit(eventName + this.constructor.EVENT_NAME_AUDIT_POSTFIX, guild, user, entry);
	}

	/**
	 * Resolve member update. This event might be used for members nicknames or roles changes.
	 * @param {module:"discord.js".GuildMember} previousMember Previous member state.
	 * @param {module:"discord.js".GuildMember} currentMember Current member state.
	 * @return {Promise<any>}
	 */
	#resolveMemberUpdate(previousMember, currentMember) {
		if (previousMember.nickname !== currentMember.nickname)
			this.#emitter.emit("rename", previousMember, currentMember);
	}

	/**
	 * Resolve channel for logging.
	 * @param {"join"|"left"|"rename"|"kick"|"ban"|"unban"} eventName
	 * @param {...[any]} args List of arguments.
	 * @return {Promise<module:"discord.js".GuildChannel>}
	 * + {@link GuildChannel} — if logging and target event enabled and logging channel specified.
	 * + null — if message sending is not required.
	 */
	async #resolveChannel(eventName, ...args) {
		/** @type {module:"discord.js".Guild} */
		const guild = this.constructor.#guildResolver[eventName]?.(...args);
		const [guildInstance] = await GuildModel.findOrCreate({
			where: {
				id: guild.id
			}
		});
		if (eventName.endsWith(this.constructor.EVENT_NAME_AUDIT_POSTFIX))
			eventName = eventName.slice(0, -this.constructor.EVENT_NAME_AUDIT_POSTFIX.length);
		if (eventName === "unban")
			eventName = "ban";
		let channelType = ["msgdelete", "msgimage", "msgupdate"].includes(eventName) ? "private" : "public";
		if (
			!guildInstance["logs_enabled"] || !guildInstance[`logs_${eventName}_event`]
			|| !guildInstance[`logs_${channelType}_channel`]
		) {
			return null;
		}
		return guild.channels.cache.get(guildInstance[`logs_${channelType}_channel`].toString());
	}

	/**
	 * Set up internal logs events.
	 */
	#handleLogEvents() {
		for (const eventName in this.constructor.#eventMessageRenderer) {
			if (!this.constructor.#eventMessageRenderer.hasOwnProperty(eventName))
				continue;
			this.#emitter.on(eventName, (...args) => this.#handleEvent(eventName, ...args));
		}
	}

	/**
	 * Handle target event by event name and arguments.
	 * @param {string} eventName Log event name.
	 * @param {any} args List of arguments passed for this event.
	 * @return {Promise<void>}
	 */
	async #handleEvent(eventName, ...args) {
		const channel = await this.#resolveChannel(eventName, ...args);
		if (!channel)
			return;
		const logMessage = this.constructor.#eventMessageRenderer[eventName]?.(...args);
		if (channel.type !== "text")
			return;
		await channel.send(logMessage);
	}

	/**
	 * Methods map for rendering event messages.
	 * @type {Object<function>}
	 */
	static #eventMessageRenderer = {
		/**
		 * Render join event.
		 * @param {module:"discord.js".GuildMember} member Target member.
		 * @return {string} Rendered string of member join.
		 */
		join: member => `:inbox_tray: [JOIN] | ${escape(`ID: ${member.id}`)} | ${escape(member.user.tag)}`,
		/**
		 * Render left event.
		 * @param {module:"discord.js".GuildMember} member Target member.
		 * @return {string} Rendered string of member left.
		 */
		left: member => `:outbox_tray: [LEAVE] | ${escape(`ID: ${member.id}`)} | ${escape(member.user.tag)}`,
		/**
		 * Render rename event.
		 * @param {module:"discord.js".GuildMember} prev Previous member state.
		 * @param {module:"discord.js".GuildMember} next Updated member state.
		 * @return {string} Rendered string of member rename.
		 */
		rename: (prev, next) => `:abc: [RENAME] | ${escape(`ID: ${prev.id}`)} | `
			+ `${escape(prev.nickname ?? prev.user.username)} → ${escape(next.nickname ?? next.user.username)}`,
		/**
		 * Render ban event with executor and reason available.
		 * @param {module:"discord.js".Guild} guild Target guild.
		 * @param {module:"discord.js".User} user Target user.
		 * @return {string} Rendered string of user banned from guild.
		 */
		ban: (guild, user) => `:hammer: [BAN] | ${escape(`ID: ${user.id}`)}`
			+ ` | ${escape(user.tag)}`,
		/**
		 * Render ban event without executor and reason available.
		 * @param {module:"discord.js".Guild} guild Target guild.
		 * @param {module:"discord.js".User} user Target user.
		 * @param {module:"discord.js".GuildAuditLogsEntry} entry Audit logs entry represents this event.
		 * @return {string} Rendered string of user banned from guild.
		 */
		banAudit: (guild, user, entry) => `:hammer: [BAN] by ${escape(entry.executor.tag)} with` + (entry.reason?.length
			? ` reason ${escape(entry.reason)}` : " no reason") + ` | ${escape(`ID: ${user.id}`)} | ${escape(user.tag)}`,
		/**
		 * Render unban event without executor and reason available.
		 * @param {module:"discord.js".Guild} guild Target guild.
		 * @param {module:"discord.js".User} user Target user.
		 * @return {string} Rendered string of user unbanned from guild.
		 */
		unban: (guild, user) => `:peace: [UNBAN] | ${escape(`ID: ${user.id}`)}`
			+ ` | ${escape(user.tag)}`,
		/**
		 * Render unban event with executor and reason available.
		 * @param {module:"discord.js".Guild} guild Target guild.
		 * @param {module:"discord.js".User} user Target user.
		 * @param {module:"discord.js".GuildAuditLogsEntry} entry Audit logs entry represents this event.
		 * @return {string} Rendered string of user banned from guild.
		 */
		unbanAudit: (guild, user, entry) => `:peace: [UNBAN] by ${escape(entry.executor.tag)}`
			+ ` | ${escape(`ID: ${user.id}`)} | ${escape(user.tag)}`,
		/**
		 * Render kick event with executor and reason if reason is passed.
		 * @param {module:"discord.js".GuildMember} member Target member.
		 * @param {module:"discord.js".GuildAuditLogsEntry} entry Target audit logs entry with reason and executor.
		 * @return {string} Rendered string of member kicked from guild with executor and possible reason.
		 */
		kick: (member, entry) => `:boot: [KICK] by ${escape(entry.executor.tag)} with` + (entry.reason?.length
			? ` reason ${escape(entry.reason)}` : " no reason") + ` | ${escape(`ID: ${member.id}`)} `
			+ `| ${escape(member.user.tag)}`,
	};

	/**
	 * Methods map for resolving guild from events.
	 * @type {Object<function>}
	 */
	static #guildResolver = {
		/**
		 * Resolve guild from join event arguments.
		 * @param {module:"discord.js".GuildMember} member Target member.
		 * @return {module:"discord.js".Guild} Resolved guild from join event.
		 */
		join: member => member.guild,
		/**
		 * Resolve guild from left event arguments.
		 * @param {module:"discord.js".GuildMember} member Target member.
		 * @return {module:"discord.js".Guild} Resolved guild from left event.
		 */
		left: member => member.guild,
		/**
		 * Resolve guild from rename event arguments.
		 * @param {module:"discord.js".GuildMember} member Target member.
		 * @return {module:"discord.js".Guild} Resolved guild from rename event.
		 */
		rename: member => member.guild,
		/**
		 * Resolve guild from ban event arguments.
		 * @param {module:"discord.js".Guild} guild Target guild.
		 * @return {module:"discord.js".Guild} Resolved guild from ban event.
		 */
		ban: guild => guild,
		/**
		 * Resolve guild from ban event arguments.
		 * @param {module:"discord.js".Guild} guild Target guild.
		 * @return {module:"discord.js".Guild} Resolved guild from ban event.
		 */
		banAudit: guild => guild,
		/**
		 * Resolve guild from unban event arguments.
		 * @param {module:"discord.js".Guild} guild Target guild.
		 * @return {module:"discord.js".Guild} Resolved guild from unban event.
		 */
		unban: guild => guild,
		/**
		 * Resolve guild from unban event arguments.
		 * @param {module:"discord.js".Guild} guild Target guild.
		 * @return {module:"discord.js".Guild} Resolved guild from unban event.
		 */
		unbanAudit: guild => guild,
		/**
		 * Resolve guild from kick event arguments.
		 * @param {module:"discord.js".GuildMember} member Target member.
		 * @return {module:"discord.js".Guild} Resolved guild from kick event.
		 */
		kick: member => member.guild
	};

	static EVENT_NAME_AUDIT_POSTFIX = "Audit";
}

module.exports = LogsProcessor;
