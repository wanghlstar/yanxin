import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { loadOAuthEnvironment } from "./oauth-env.mjs";
const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const key = path.join(os.homedir(), ".config/yanxin-release/updater.key");
const env = await loadOAuthEnvironment(process.cwd());
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!fs.existsSync(key))
    throw new Error(
      "缺少更新签名密钥。发布者请恢复 ~/.config/yanxin-release/updater.key；仅本地构建可使用 tauri build --config 覆盖 createUpdaterArtifacts=false。",
    );
  if (
    fs.readFileSync(key + ".pub", "utf8").trim() !==
    config.plugins.updater.pubkey
  )
    throw new Error("本机密钥与应用公钥不匹配，停止构建。");
  env.TAURI_SIGNING_PRIVATE_KEY = key;
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
}
// 本机装有固定签名证书时用它（否则 tauri.conf.json 的 "-" ad-hoc 签名每次指纹都变，
// 钥匙串"始终允许"会随每次编译失效）。requirement 按证书签、与二进制内容无关。
// CI 的 runner 没有本机证书，也不该有：保持 "-" ad-hoc，由 APPLE_SIGNING_IDENTITY
// 区分本机与 CI，不要把证书名写进 tauri.conf.json。
const signingIdentity =
  process.env.YANXIN_SIGNING_IDENTITY || "Yanxin Local Code Signing";
const identities = spawnSync("security", ["find-identity"], {
  encoding: "utf8",
});
if (
  identities.status === 0 &&
  identities.stdout.includes(`"${signingIdentity}"`)
) {
  env.APPLE_SIGNING_IDENTITY = signingIdentity;
  console.log(`使用固定签名身份：${signingIdentity}`);
} else if (process.platform === "darwin" && !process.env.CI) {
  console.warn(
    `未找到签名身份「${signingIdentity}」，本次使用 ad-hoc 签名；钥匙串授权将随每次编译失效。`,
  );
}
const child = spawn(
  path.resolve("node_modules/.bin/tauri"),
  ["build", "--bundles", "app", ...process.argv.slice(2)],
  { env, stdio: "inherit" },
);
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
