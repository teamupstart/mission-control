const { app } = require("electron");
const { measurePages, pagesFromArgv } = require("./measuring-window.cjs");

app.whenReady().then(async () => {
  const result = await measurePages({
    paths: pagesFromArgv(process.argv), viewport: { width: 720, height: 480 }, budgetMs: 60000,
    measure: `() => ({
      content: document.querySelector("main").getBoundingClientRect().bottom,
      line: document.querySelector(".vi-status-line").getBoundingClientRect().toJSON(),
    })`,
  });
  process.stdout.write(JSON.stringify(result), () => app.exit(0));
}).catch(error => {
  console.error(error);
  app.exit(1);
});
