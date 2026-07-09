const mongoose = require("mongoose");

const questionHistorySchema = new mongoose.Schema(
  {
    roomCode: {
      type: String,
      index: true,
    },
    question: String,
    options: [String],
    correct: Number,
    addedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    addedBySocketId: String,
  },
  { collection: "quiz_question_history" }
);

questionHistorySchema.index({ roomCode: 1, addedAt: -1 });

module.exports = mongoose.models.QuestionHistory || mongoose.model("QuestionHistory", questionHistorySchema);