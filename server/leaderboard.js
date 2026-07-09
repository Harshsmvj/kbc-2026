const mongoose = require("mongoose");

const leaderboardSchema = new mongoose.Schema(
  {
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
  },
  { collection: "quiz_leaderboards" }
);

leaderboardSchema.index({ roomCode: 1, playedAt: -1 });

module.exports = mongoose.models.Leaderboard || mongoose.model("Leaderboard", leaderboardSchema);
