const path = require("node:path");
const Mocha = require("mocha");

async function run() {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 60_000,
    grep: process.env.OPENCLAW_TEST_GREP || undefined,
  });

  mocha.addFile(path.resolve(__dirname, "./extension.test.js"));

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration test(s) failed.`));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  run,
};
