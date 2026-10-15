const fs = require("fs");
const path = require("path");

const ssh2Path = process.env.SSH2_PATH;
if (ssh2Path) {
  module.paths.push(path.join(ssh2Path, "node_modules"));
}

const { Client } = require("ssh2");

const remoteBuildDir = "/opt/sejbosejbo-src";
const remoteRunDir = "/opt/sejbosejbo";
const root = path.resolve(__dirname, "..");

const config = {
  host: process.env.PI_HOST || "127.0.0.1",
  username: process.env.PI_USER || "ldocker",
  password: process.env.PI_PASSWORD
};

if (!config.password) {
  console.error("Set PI_PASSWORD before running this script.");
  process.exit(1);
}

const ignoredDirs = new Set(["node_modules", "data", "uploads", ".git"]);
const ignoredFiles = new Set(["npm-debug.log"]);

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => resolve(conn));
    conn.on("error", reject);
    conn.connect(config);
  });
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("data", (data) => {
        stdout += data;
      });
      stream.stderr.on("data", (data) => {
        stderr += data;
      });
      stream.on("close", (code) => {
        if (code === 0) return resolve({ stdout, stderr });
        reject(new Error(`Command failed (${code}): ${command}\n${stderr || stdout}`));
      });
    });
  });
}

function sftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, client) => (err ? reject(err) : resolve(client)));
  });
}

function mkdirp(conn, remotePath) {
  return exec(conn, `mkdir -p '${remotePath.replaceAll("'", "'\\''")}'`);
}

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll("\\", "/");
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    if (entry.isFile() && ignoredFiles.has(entry.name)) continue;
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.isFile()) {
      files.push({ full, rel });
    }
  }
  return files;
}

function uploadFile(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const conn = await connect();
  try {
    const info = await exec(conn, "uname -m && docker --version && docker compose version");
    console.log(info.stdout.trim());

    await exec(conn, `rm -rf '${remoteBuildDir}' && mkdir -p '${remoteBuildDir}' '${remoteRunDir}/data' '${remoteRunDir}/uploads'`);
    const client = await sftp(conn);
    const files = listFiles(root);
    const madeDirs = new Set();

    for (const file of files) {
      const remoteFile = `${remoteBuildDir}/${file.rel}`;
      const remoteDir = path.posix.dirname(remoteFile);
      if (!madeDirs.has(remoteDir)) {
        await mkdirp(conn, remoteDir);
        madeDirs.add(remoteDir);
      }
      await uploadFile(client, file.full, remoteFile);
      console.log(`uploaded ${file.rel}`);
    }

    await exec(conn, `cp '${remoteBuildDir}/deploy/docker-compose.yml' '${remoteRunDir}/docker-compose.yml'`);
    await exec(conn, `if [ ! -f '${remoteRunDir}/.env' ]; then cp '${remoteBuildDir}/deploy/.env.example' '${remoteRunDir}/.env'; fi`);
    await exec(conn, `cd '${remoteRunDir}' && sed -i 's#DOCKERHUB_USERNAME/sejbosejbo:latest#${process.env.DOCKER_IMAGE || "DOCKERHUB_USERNAME/sejbosejbo:latest"}#' docker-compose.yml`);

    console.log(`Prepared build folder: ${remoteBuildDir}`);
    console.log(`Prepared compose folder: ${remoteRunDir}`);
  } finally {
    conn.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
