/* eslint-disable @typescript-eslint/no-require-imports */
const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 8080;
const publicDir = path.join(__dirname);
const artifactsDir = path.join(__dirname, "../artifacts");

app.use(express.static(publicDir));
app.use("/artifacts", express.static(artifactsDir));

app.listen(port, () => {
  console.log(`Demo server running at http://localhost:${port}`);
});
