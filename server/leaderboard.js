const mongoose = require("mongoose");

const leaderboardSchema = new mongoose.Schema({
  roomCode: String,
  playedAt: {
    type: Date,
    default: Date.now,
  },
  leaderboard: [
    {
      name: String,
      score: Number,
    },
  ],
  totalQuestions: Number,
});

module.exports = mongoose.model("Leaderboard", leaderboardSchema);
