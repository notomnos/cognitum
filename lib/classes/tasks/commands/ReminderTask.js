const BaseTask = require("../../base/BaseTask.js");
const DirectMessageEmbed = require("../../embed/DirectMessageEmbed.js");
const Lang = require("../../localization/Lang.js");
const { createModuleLog } = require("../../Utils.js");
const log = createModuleLog("ReminderTask");

class ReminderTask extends BaseTask {
	/**
	 * @param {Object} options
	 * @param {CognitumClient} options.discordClient
	 * @return {Promise<void>}
	 */
	async run({ discordClient }) {
		const userId = this.payload?.["userId"];
		const messageText = this.payload?.["message"];
		if (!userId)
			return log("error", `User ID is not set! Task ID: ${this.id}.`);
		const targetUser = await discordClient.users.fetch(userId);
		if (!targetUser)
			return log("error", `User not found! ID: ${userId}.`);
		const embed = new DirectMessageEmbed(targetUser);
		const lang = new Lang("en");
		embed.setTitle(lang.get("embed.tasks.reminder.title"));
		if (!messageText || !messageText?.length)
			embed.setDescription(lang.get("embed.tasks.reminder.descriptionEmpty"));
		else
			embed.setDescription(
				lang.get("embed.tasks.reminder.description", {
					reminderMessage: messageText
				})
			);
		embed.setFooter(lang.get("embed.tasks.reminder.footer"));
		embed.setTimestamp(new Date());
		try {
			await targetUser.send(embed);
		} catch (e) {
			log("warn", `Task ${this.id} skipped: Failed to deliver message to user!`);
		}
	}

	static code = "reminder";
	static save = true;
}

module.exports = ReminderTask;
