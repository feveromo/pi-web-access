import { homedir } from "node:os";
import { join } from "node:path";

export function getWebSearchConfigDir() {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi");
	return join(homedir(), ".pi");
}

export function getWebSearchConfigPath() {
	return join(getWebSearchConfigDir(), "web-search.json");
}
