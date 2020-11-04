const BaseCommand = require("../../classes/base/BaseCommand");
const DefaultEmbed = require("../../classes/embed/DefaultEmbed");
const CoreCategory = require("../../categories/CoreCategory");

class AboutCommand extends BaseCommand {
	async run() {
		return new DefaultEmbed(this.context, "self")
			.setTitle(
				this.resolveLang("bot.name")
			)
			.setDescription(
				this.resolveLang("bot.description")
			)
			.addField(
				this.resolveLang("command.about.links.title"),
				this.resolveLang("command.about.links.description")
			);
	}

	static code = "about";
	static category = CoreCategory.getCode();
}

module.exports = AboutCommand;
