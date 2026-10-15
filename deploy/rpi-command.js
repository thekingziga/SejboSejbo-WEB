const path = require("path");

const ssh2Path = process.env.SSH2_PATH;
if (ssh2Path) {
  module.paths.push(path.join(ssh2Path, "node_modules"));
}

const { Client } = require("ssh2");

const command = process.argv.slice(2).join(" ");
if (!command) {
  console.error("Usage: node deploy/rpi-command.js <command>");
  process.exit(1);
}

const conn = new Client();
conn.on("ready", () => {
  conn.exec(command, (err, stream) => {
    if (err) throw err;
    stream.on("data", (data) => process.stdout.write(data));
    stream.stderr.on("data", (data) => process.stderr.write(data));
    stream.on("close", (code) => {
      conn.end();
      process.exit(code);
    });
  });
});
conn.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
conn.connect({
  host: process.env.PI_HOST || "192.168.69.29",
  username: process.env.PI_USER || "ldocker",
  password: process.env.PI_PASSWORD
});
