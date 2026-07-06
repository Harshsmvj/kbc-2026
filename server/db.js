const mongoose = require("mongoose");

mongoose.connect("mongodb://127.0.0.1:27017/kbc-quiz").catch((err) => {
  console.warn("MongoDB unavailable — running in offline mode:", err.message);
});

mongoose.connection.once("open", () => {
  console.log("MongoDB connected");
});

mongoose.connection.on("error", (err) => {
  console.warn("MongoDB error:", err.message);
});

module.exports = mongoose;
