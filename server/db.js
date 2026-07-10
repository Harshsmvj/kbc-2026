const mongoose = require("mongoose");

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/kbc-quiz";

mongoose.connect(mongoUri).catch((err) => {
  console.warn("MongoDB unavailable — running in offline mode:", err.message);
});

mongoose.connection.once("open", () => {
  console.log("MongoDB connected");
  console.log("Connected to:", mongoose.connection.host);
  console.log("Database:", mongoose.connection.name);
});

mongoose.connection.on("error", (err) => {
  console.warn("MongoDB error:", err.message);
});

module.exports = mongoose;
