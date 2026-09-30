import { chromium } from "playwright";
import { spawn } from "node:child_process";

const nodes = [["hyhk01", "172.20.177.34"], ["hyhk02", "172.20.177.36"], ["hyhk03", "172.20.177.37"], ["hyhk04", "172.20.177.38"]];
function runRemote(host, script) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [host, "sh", "-s"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${host} exit ${code}\n${stderr}\n${stdout}`)));
    child.stdin.end(script);
  });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto("http://127.0.0.1:3503/");
await page.locator("#authPassword").fill("testpass123");
await page.locator("#authSubmitButton").click();
await page.waitForTimeout(800);
await page.locator("button").filter({ hasText: "资源管理" }).first().click();
await page.locator("button").filter({ hasText: "受管节点" }).click();

for (const [host, routerId] of nodes) {
  console.log("ADDING", host);
  await page.locator("button").filter({ hasText: "+ 添加节点" }).click();
  await page.locator("#nodeEditorName").fill(host);
  await page.locator("#nodeEditorRouterId").fill(routerId);
  await page.locator("#nodeEditorIgpAddress").fill(routerId);
  await page.locator("button").filter({ hasText: "生成准备脚本" }).click();
  await page.waitForTimeout(250);
  const script = await page.locator("pre").filter({ hasText: "#!/bin/sh" }).last().textContent();
  if (!script) throw new Error(`${host}: setup script missing`);
  const result = await runRemote(host, script);
  console.log(host, "remote", result.stdout.trim().slice(-200), result.stderr.trim().slice(-300));
  await page.waitForTimeout(1800);
  const testButton = page.locator("button").filter({ hasText: "测试连接" }).last();
  await testButton.click();
  await page.waitForTimeout(1500);
  console.log(host, "test", (await page.locator("body").innerText()).slice(-600));
  await page.locator("button").filter({ hasText: "保存节点" }).last().click();
  await page.waitForTimeout(1200);
  console.log(host, "saved", await page.locator("#nodeEditorName").count());
}
console.log("FINAL", (await page.locator("body").innerText()).slice(-3000));
await browser.close();
