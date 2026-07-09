const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    roomCode: {
      type: String,
      index: true,
    },
    playerToken: {
      type: String,
      index: true,
    },
    name: String,
    ipAddress: String,
    userAgent: String,
    joinedAt: {
      type: Date,
      default: Date.now,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
    },
    joinCount: {
      type: Number,
      default: 1,
    },
    connected: {
      type: Boolean,
      default: true,
    },
    isHostPlayer: {
      type: Boolean,
      default: false,
    },
  },
  { collection: "quiz_participants" }
);

participantSchema.index({ roomCode: 1, playerToken: 1 }, { unique: true });

module.exports = mongoose.models.QuizParticipant || mongoose.model("QuizParticipant", participantSchema);