const fs = require("node:fs");
const path = require("node:path");

class JsonStore {
  constructor(dataFile, seedFactory) {
    this.dataFile = dataFile;
    this.seedFactory = seedFactory;
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    if (!fs.existsSync(this.dataFile)) {
      this.write(this.seedFactory());
    }
  }

  read() {
    this.ensureFile();
    return JSON.parse(fs.readFileSync(this.dataFile, "utf8"));
  }

  write(data) {
    fs.writeFileSync(this.dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  update(updater) {
    const data = this.read();
    const result = updater(data);
    this.write(data);
    return result;
  }

  check() {
    const data = this.read();
    return Boolean(data && Array.isArray(data.users) && Array.isArray(data.orders));
  }
}

module.exports = { JsonStore };
