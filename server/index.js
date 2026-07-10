require("dotenv").config();
const mongoose = require("./db");

const Leaderboard = require("./leaderboard");
const QuizParticipant = require("./participant");
const QuestionHistory = require("./question-history");
const defaultQuestions = require("./question");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "kbc_admin_123";
const DEFAULT_QUESTION_TIME = 15;
const REVEAL_TIME = 3;
const PLAYER_REJOIN_GRACE_MS =
  Number.parseInt(process.env.PLAYER_REJOIN_GRACE_MS, 10) || 10 * 60 * 1000;
const PORT = Number.parseInt(process.env.PORT, 10) || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

const roomStatus = {};
const roomPlayers = {};
const roomTimers = {};
const playerRemovalTimers = {};
let activeQuizRoomCode = null;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

const cloneQuestions = (questions) =>
  questions.map((q) => ({
    _id: q._id ? String(q._id) : undefined,
    question: q.question,
    options: [...q.options],
    correct: q.correct,
    addedAt: q.addedAt,
  }));

const sanitizeQuestions = (questions) =>
  questions.map(({ question, options }) => ({ question, options }));

const getClientIp = (socket) => {
  const forwardedFor = socket.handshake.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return socket.handshake.address || socket.conn?.remoteAddress || "unknown";
};

const saveParticipant = async ({ roomCode, playerToken, name, socket, isHostPlayer = false }) => {
  try {
    const savedParticipant = await QuizParticipant.findOneAndUpdate(
      { roomCode, playerToken },
      {
        $set: {
          name,
          ipAddress: getClientIp(socket),
          userAgent: socket.handshake.headers["user-agent"] || "",
          lastSeenAt: new Date(),
          connected: true,
          isHostPlayer,
        },
        $setOnInsert: {
          joinedAt: new Date(),
        },
        $inc: {
          joinCount: 1,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (savedParticipant) {
      io.emit("admin-db-updated");
    }
  } catch (err) {
    console.warn("Participant save skipped (offline mode):", err.message);
  }
};

const markParticipantDisconnected = async ({ roomCode, playerToken }) => {
  try {
    const updatedParticipant = await QuizParticipant.findOneAndUpdate(
      { roomCode, playerToken },
      {
        $set: {
          connected: false,
          lastSeenAt: new Date(),
        },
      }
    );

    if (updatedParticipant) {
      io.emit("admin-db-updated");
    }
  } catch (err) {
    console.warn("Participant disconnect save skipped (offline mode):", err.message);
  }
};

const saveQuestionHistory = async ({ roomCode, question, socket }) => {
  try {
    const savedQuestion = await QuestionHistory.create({
      roomCode,
      question: question.question.trim(),
      options: question.options.map((opt) => opt.trim()),
      correct: question.correct,
      addedBySocketId: socket.id,
    });

    io.emit("admin-db-updated");
    return savedQuestion;
  } catch (err) {
    console.warn("Question history save skipped (offline mode):", err.message);
    return null;
  }
};

const loadPersistedQuestions = async () => {
  try {
    return await QuestionHistory.find({}).sort({ addedAt: 1 });
  } catch (err) {
    console.warn("Question history load skipped (offline mode):", err.message);
    return [];
  }
};

const normalizeRoomCode = (roomCode) => String(roomCode).trim();

const isValidRoomCode = (roomCode) => /^\d{6}$/.test(normalizeRoomCode(roomCode));

const isHost = (socket, roomCode) =>
  roomStatus[normalizeRoomCode(roomCode)]?.hostSocketId === socket.id;

const clearPlayerRemovalTimer = (roomCode, playerId) => {
  if (playerRemovalTimers[roomCode]?.[playerId]) {
    clearTimeout(playerRemovalTimers[roomCode][playerId]);
    delete playerRemovalTimers[roomCode][playerId];
  }
};

const schedulePlayerRemoval = (roomCode, playerId) => {
  if (!playerRemovalTimers[roomCode]) {
    playerRemovalTimers[roomCode] = {};
  }

  clearPlayerRemovalTimer(roomCode, playerId);

  playerRemovalTimers[roomCode][playerId] = setTimeout(() => {
    const players = roomPlayers[roomCode];
    if (!players?.[playerId]?.connected) {
      delete players[playerId];
      emitPlayersList(roomCode);
    }
    clearPlayerRemovalTimer(roomCode, playerId);
  }, PLAYER_REJOIN_GRACE_MS);
};

const clearRoomPlayerTimers = (roomCode) => {
  const timers = playerRemovalTimers[roomCode];
  if (!timers) return;

  Object.values(timers).forEach((timerId) => clearTimeout(timerId));
  delete playerRemovalTimers[roomCode];
};

const getPlayersList = (roomCode) => {
  const room = roomStatus[roomCode];
  const players = roomPlayers[roomCode];
  if (!players) return [];

  return Object.entries(players).map(([id, player]) => ({
    playerId: id,
    socketId: player.socketId,
    name: player.name,
    score: player.score,
    connected: !!player.connected,
    answeredCurrent:
      room?.phase === "question" &&
      player.answers?.[room.currentIndex] !== undefined,
  }));
};

const getLeaderboardData = (roomCode) =>
  Object.values(roomPlayers[roomCode] || {})
    .map((p) => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

const clearRoomTimers = (roomCode) => {
  if (roomTimers[roomCode]) {
    clearTimeout(roomTimers[roomCode]);
    delete roomTimers[roomCode];
  }
};

const scheduleQuestionTimer = (roomCode) => {
  const room = roomStatus[roomCode];
  if (!room || room.phase !== "question") return;

  const elapsedMs = Date.now() - room.questionStartedAt;
  const remainingMs = Math.max(0, room.questionTime * 1000 - elapsedMs);

  clearRoomTimers(roomCode);

  if (remainingMs === 0) {
    endQuestionTimer(roomCode);
    return;
  }

  roomTimers[roomCode] = setTimeout(() => endQuestionTimer(roomCode), remainingMs);
};

const emitPlayersList = (roomCode) => {
  const hostId = roomStatus[roomCode]?.hostSocketId;
  if (!hostId) return;
  io.to(hostId).emit("players-list", getPlayersList(roomCode));
};

const emitQuestionsUpdated = (roomCode) => {
  const room = roomStatus[roomCode];
  if (!room) return;
  io.to(roomCode).emit("questions-updated", room.questions);
};

const buildSyncPayload = (roomCode, playerId = null) => {
  const room = roomStatus[roomCode];
  const question = room.questions[room.currentIndex];
  const elapsed = Math.floor((Date.now() - room.questionStartedAt) / 1000);
  const timeLeft = Math.max(0, room.questionTime - elapsed);
  const playerAnswer = playerId
    ? roomPlayers[roomCode]?.[playerId]?.answers?.[room.currentIndex]
    : undefined;

  const payload = {
    currentIndex: room.currentIndex,
    totalQuestions: room.questions.length,
    timeLeft,
    phase: room.phase,
    questionEndsAt: room.questionStartedAt + room.questionTime * 1000,
    questionTime: room.questionTime,
    question: question
      ? { question: question.question, options: question.options }
      : null,
  };

  if (playerAnswer !== undefined) {
    payload.playerAnswer = playerAnswer;
  }

  if (room.phase === "reveal") {
    payload.correctAnswer = question.correct;
    payload.revealEndsAt = room.revealEndsAt;
  }

  return payload;
};

const emitQuizSync = (roomCode) => {
  const room = roomStatus[roomCode];
  if (!room) return;

  const sync = buildSyncPayload(roomCode);
  io.to(roomCode).emit("quiz-sync", sync);
  io.to(room.hostSocketId).emit("quiz-sync-host", {
    ...sync,
    players: getPlayersList(roomCode),
  });
};

const scoreCurrentQuestion = (roomCode) => {
  const room = roomStatus[roomCode];
  const question = room.questions[room.currentIndex];
  const players = roomPlayers[roomCode] || {};

  Object.values(players).forEach((player) => {
    if (player.answers?.[room.currentIndex] === question.correct) {
      player.score += 1;
    }
  });
};

const finishQuiz = async (roomCode, endedEarly = false) => {
  const room = roomStatus[roomCode];
  if (!room) return;

  clearRoomTimers(roomCode);
  room.phase = "finished";
  room.started = false;
  activeQuizRoomCode = null;

  const leaderboard = getLeaderboardData(roomCode);
  await saveLeaderboard(roomCode, leaderboard, room.questions.length);

  io.to(roomCode).emit("quiz-ended", { leaderboard, endedEarly });
  io.to(room.hostSocketId).emit("quiz-finished", leaderboard);
  emitPlayersList(roomCode);
};

const advanceQuestion = (roomCode) => {
  const room = roomStatus[roomCode];
  if (!room || room.phase === "finished") return;

  room.currentIndex += 1;

  if (room.currentIndex >= room.questions.length) {
    finishQuiz(roomCode);
    return;
  }

  startQuestion(roomCode);
};

const endQuestionTimer = (roomCode) => {
  const room = roomStatus[roomCode];
  if (!room || room.phase !== "question") return;

  room.phase = "reveal";
  room.revealEndsAt = Date.now() + REVEAL_TIME * 1000;
  scoreCurrentQuestion(roomCode);
  emitQuizSync(roomCode);
  emitPlayersList(roomCode);

  roomTimers[roomCode] = setTimeout(
    () => advanceQuestion(roomCode),
    REVEAL_TIME * 1000
  );
};

const startQuestion = (roomCode) => {
  const room = roomStatus[roomCode];
  room.phase = "question";
  room.questionStartedAt = Date.now();
  const sync = buildSyncPayload(roomCode);
  io.to(roomCode).emit("quiz-sync", sync);
  io.to(room.hostSocketId).emit("quiz-sync-host", {
    ...sync,
    players: getPlayersList(roomCode),
  });
  scheduleQuestionTimer(roomCode);
  return sync;
};

const resetRoomQuiz = (roomCode) => {
  const room = roomStatus[roomCode];
  if (!room) return;

  clearRoomTimers(roomCode);
  room.started = false;
  room.phase = "lobby";
  room.currentIndex = 0;
  room.hostPlaying = false;

  if (activeQuizRoomCode === roomCode) {
    activeQuizRoomCode = null;
  }

  const players = roomPlayers[roomCode];
  if (players) {
    Object.entries(players).forEach(([id, player]) => {
      player.score = 0;
      player.answers = {};
      if (player.connected) {
        clearPlayerRemovalTimer(roomCode, id);
      }
    });
  }
};

const saveLeaderboard = async (roomCode, leaderboardData, totalQuestions) => {
  try {
    const savedLeaderboard = await Leaderboard.create({
      roomCode,
      leaderboard: leaderboardData,
      totalQuestions,
    });

    io.emit("admin-db-updated");
    return savedLeaderboard;
  } catch (err) {
    console.warn("Leaderboard save skipped (offline mode):", err.message);
    return null;
  }
};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("admin-login", ({ password }) => {
    const trimmed = password?.trim();

    if (trimmed === ADMIN_PASSWORD) {
      socket.emit("admin-login-result", { success: true });
      return;
    }

    socket.emit("admin-login-result", {
      success: false,
      message: "Wrong admin password.",
    });
  });

  socket.on("create-room", async () => {
    let roomCode = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = Math.floor(100000 + Math.random() * 900000).toString();
      if (!roomStatus[candidate]) {
        roomCode = candidate;
        break;
      }
    }

    if (!roomCode) {
      socket.emit("host-error", "Could not allocate a room code. Please try again.");
      return;
    }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;

    const persistedQuestions = await loadPersistedQuestions();

    roomStatus[roomCode] = {
      started: false,
      phase: "lobby",
      currentIndex: 0,
      hostSocketId: socket.id,
      hostPlaying: false,
      questionTime: DEFAULT_QUESTION_TIME,
      questions: [...cloneQuestions(defaultQuestions), ...cloneQuestions(persistedQuestions)],
    };

    roomPlayers[roomCode] = {};
    playerRemovalTimers[roomCode] = {};

    console.log("Room created:", roomCode);

    socket.emit("room-created", {
      roomCode,
      questions: roomStatus[roomCode].questions,
      questionTime: roomStatus[roomCode].questionTime,
    });
    emitPlayersList(roomCode);
  });

  socket.on("join-room", ({ roomCode, name, playerToken }) => {
    const code = normalizeRoomCode(roomCode);
    const trimmedName = name?.trim();
    const playerId = String(playerToken || "").trim();

    if (!trimmedName) {
      socket.emit("join-error", "Enter your name to join.");
      return;
    }

    if (!playerId) {
      socket.emit("join-error", "Missing player session. Refresh the page and try again.");
      return;
    }

    if (!isValidRoomCode(code)) {
      socket.emit("join-error", "Invalid room code. It must be a 6-digit number.");
      return;
    }

    const room = roomStatus[code];
    if (!room) {
      socket.emit("join-error", "Room not found. Check the code with your host.");
      return;
    }

    const roomPlayersList = Object.entries(roomPlayers[code] || {});
    const existingNames = roomPlayersList
      .filter(([id]) => id !== playerId)
      .map(([, p]) => p.name.toLowerCase());
    if (existingNames.includes(trimmedName.toLowerCase())) {
      socket.emit("join-error", "That name is already taken in this room.");
      return;
    }

    socket.join(code);
    socket.roomCode = code;
    socket.playerId = playerId;

    if (!roomPlayers[code]) {
      roomPlayers[code] = {};
    }

    const existingPlayer = roomPlayers[code][playerId];

    if (existingPlayer) {
      clearPlayerRemovalTimer(code, playerId);
      existingPlayer.name = trimmedName;
      existingPlayer.connected = true;
      existingPlayer.socketId = socket.id;
      delete existingPlayer.disconnectedAt;
    } else {
      roomPlayers[code][playerId] = {
        name: trimmedName,
        score: 0,
        answers: {},
        connected: true,
        socketId: socket.id,
      };
    }

    void saveParticipant({
      roomCode: code,
      playerToken: playerId,
      name: trimmedName,
      socket,
      isHostPlayer: false,
    });

    const quizSync = room.started ? buildSyncPayload(code, playerId) : null;

    console.log(trimmedName, "joined room", code);

    socket.emit("join-success", {
      roomCode: code,
      name: trimmedName,
      questions: room.questions,
      quizStarted: room.started,
      quizSync,
      playerId,
      resumed: !!existingPlayer,
    });
    io.to(code).emit("player-joined", trimmedName);
    emitPlayersList(code);
  });

  socket.on("host-join-as-player", ({ roomCode, name }) => {
    const code = normalizeRoomCode(roomCode);

    if (!isHost(socket, code)) {
      socket.emit("host-error", "Only the host can join as a player.");
      return;
    }

    const room = roomStatus[code];
    if (!room) {
      socket.emit("host-error", "Room not found.");
      return;
    }

    const trimmedName = (name || "Host").trim();
    const existingNames = Object.values(roomPlayers[code] || {})
      .filter((p) => roomPlayers[code][socket.id] !== p)
      .map((p) => p.name.toLowerCase());

    if (existingNames.includes(trimmedName.toLowerCase())) {
      socket.emit("host-error", "That name is already taken in this room.");
      return;
    }

    roomPlayers[code][socket.id] = {
      name: trimmedName,
      score: 0,
      answers: {},
      connected: true,
      socketId: socket.id,
    };
    socket.playerId = socket.id;
    room.hostPlaying = true;

    void saveParticipant({
      roomCode: code,
      playerToken: socket.id,
      name: trimmedName,
      socket,
      isHostPlayer: true,
    });

    const quizSync = room.started ? buildSyncPayload(code, socket.id) : null;

    socket.emit("host-join-success", {
      name: trimmedName,
      quizStarted: room.started,
      quizSync,
      questionTime: room.questionTime,
    });
    emitPlayersList(code);
  });

  socket.on("host-leave-quiz", (roomCode) => {
    const code = normalizeRoomCode(roomCode);

    if (!isHost(socket, code)) return;

    const room = roomStatus[code];
    if (!room || room.started) {
      socket.emit("host-error", "Cannot leave while quiz is running.");
      return;
    }

    delete roomPlayers[code]?.[socket.id];
    clearPlayerRemovalTimer(code, socket.id);
    void markParticipantDisconnected({ roomCode: code, playerToken: socket.id });
    room.hostPlaying = false;
    socket.emit("host-leave-success");
    emitPlayersList(code);
  });

  socket.on("add-question", async ({ roomCode, question }) => {
    if (!isHost(socket, roomCode)) {
      socket.emit("host-error", "Only the host can add questions.");
      return;
    }

    const room = roomStatus[roomCode];
    if (!room || room.started) {
      socket.emit("host-error", "Cannot edit questions while a quiz is running.");
      return;
    }

    if (
      !question?.question?.trim() ||
      !Array.isArray(question.options) ||
      question.options.length !== 4 ||
      question.options.some((opt) => !opt?.trim()) ||
      question.correct < 0 ||
      question.correct > 3
    ) {
      socket.emit("host-error", "Question needs text, 4 options, and a correct answer.");
      return;
    }

    const savedQuestion = await saveQuestionHistory({
      roomCode,
      question,
      socket,
    });

    room.questions.push(
      savedQuestion
        ? {
            _id: String(savedQuestion._id),
            question: savedQuestion.question,
            options: [...savedQuestion.options],
            correct: savedQuestion.correct,
            addedAt: savedQuestion.addedAt,
          }
        : {
            question: question.question.trim(),
            options: question.options.map((opt) => opt.trim()),
            correct: question.correct,
          }
    );

    emitQuestionsUpdated(roomCode);
  });

  socket.on("set-question-time", ({ roomCode, questionTime }) => {
    if (!isHost(socket, roomCode)) {
      socket.emit("host-error", "Only the host can change the timer.");
      return;
    }

    const room = roomStatus[roomCode];
    if (!room) {
      socket.emit("host-error", "Room not found.");
      return;
    }

    const nextTime = Number.parseInt(questionTime, 10);
    if (!Number.isFinite(nextTime) || nextTime < 5 || nextTime > 300) {
      socket.emit("host-error", "Question timer must be between 5 and 300 seconds.");
      return;
    }

    room.questionTime = nextTime;

    if (room.phase === "question") {
      scheduleQuestionTimer(roomCode);
      emitQuizSync(roomCode);
    }

    socket.emit("question-time-updated", { questionTime: room.questionTime });
  });

  socket.on("remove-question", async ({ roomCode, index }) => {
    if (!isHost(socket, roomCode)) {
      socket.emit("host-error", "Only the host can remove questions.");
      return;
    }

    const room = roomStatus[roomCode];
    if (!room || room.started) {
      socket.emit("host-error", "Cannot edit questions while a quiz is running.");
      return;
    }

    if (index < 0 || index >= room.questions.length) {
      socket.emit("host-error", "Invalid question index.");
      return;
    }

    if (room.questions.length <= 1) {
      socket.emit("host-error", "At least one question is required.");
      return;
    }

    const [removedQuestion] = room.questions.splice(index, 1);

    if (removedQuestion?._id) {
      try {
        await QuestionHistory.deleteOne({ _id: removedQuestion._id });
        io.emit("admin-db-updated");
      } catch (err) {
        console.warn("Question delete skipped (offline mode):", err.message);
      }
    }

    emitQuestionsUpdated(roomCode);
  });

  socket.on("kick-player", ({ roomCode, targetPlayerId, targetSocketId }) => {
    if (!isHost(socket, roomCode)) {
      socket.emit("host-error", "Only the host can remove players.");
      return;
    }

    const room = roomStatus[roomCode];
    const playerId = targetPlayerId || targetSocketId;
    if (playerId === room?.hostSocketId) {
      socket.emit("host-error", "Use 'Stop Playing' to leave the quiz yourself.");
      return;
    }

    const player = roomPlayers[roomCode]?.[playerId];
    if (!player) {
      socket.emit("host-error", "Player not found.");
      return;
    }

    clearPlayerRemovalTimer(roomCode, playerId);

    if (player.socketId) {
      io.to(player.socketId).emit("kicked", {
        message: "You were removed from the quiz by the host.",
      });
    }

    delete roomPlayers[roomCode][playerId];

    const targetSocket = player.socketId && io.sockets.sockets.get(player.socketId);
    if (targetSocket) {
      targetSocket.leave(roomCode);
      delete targetSocket.roomCode;
      delete targetSocket.playerId;
    }

    void markParticipantDisconnected({ roomCode, playerToken: playerId });

    emitPlayersList(roomCode);
    io.to(roomCode).emit("player-left", player.name);
  });

  socket.on("start-quiz", (roomCode) => {
    const code = normalizeRoomCode(roomCode);

    if (!isHost(socket, code)) {
      socket.emit("host-error", "Only the host can start the quiz.");
      return;
    }

    const room = roomStatus[code];
    if (!room) {
      socket.emit("host-error", "Room not found.");
      return;
    }

    if (activeQuizRoomCode && activeQuizRoomCode !== code) {
      socket.emit(
        "host-error",
        "Another quiz is already running. End it before starting a new one."
      );
      return;
    }

    if (room.questions.length === 0) {
      socket.emit("host-error", "Add at least one question before starting.");
      return;
    }

    activeQuizRoomCode = code;
    room.started = true;
    room.currentIndex = 0;
    room.phase = "question";

    Object.values(roomPlayers[code]).forEach((player) => {
      player.score = 0;
      player.answers = {};
    });

    console.log("Quiz started in room", code);

    const sanitized = sanitizeQuestions(room.questions);
    const quizSync = startQuestion(code);

    io.to(code).emit("quiz-started", {
      questions: sanitized,
      questionTime: room.questionTime,
      quizSync,
    });
    socket.emit("quiz-started-host", {
      questions: sanitized,
      hostPlaying: room.hostPlaying,
      questionTime: room.questionTime,
      quizSync,
    });
    emitPlayersList(code);
  });

  socket.on("end-quiz", (roomCode) => {
    const code = normalizeRoomCode(roomCode);

    if (!isHost(socket, code)) {
      socket.emit("host-error", "Only the host can end the quiz.");
      return;
    }

    const room = roomStatus[code];
    if (!room || !room.started) {
      socket.emit("host-error", "No quiz is running in this room.");
      return;
    }

    if (room.phase === "question") {
      scoreCurrentQuestion(code);
    }

    console.log("Quiz ended early in room", code);
    finishQuiz(code, true);
  });

  socket.on("start-new-quiz", (roomCode) => {
    const code = normalizeRoomCode(roomCode);

    if (!isHost(socket, code)) {
      socket.emit("host-error", "Only the host can start a new quiz.");
      return;
    }

    const room = roomStatus[code];
    if (!room) {
      socket.emit("host-error", "Room not found.");
      return;
    }

    if (room.started) {
      socket.emit("host-error", "End the current quiz before starting a new one.");
      return;
    }

    resetRoomQuiz(code);

    console.log("New quiz reset in room", code);

    io.to(code).emit("quiz-reset");
    socket.emit("quiz-reset-host", { questions: room.questions });
    emitPlayersList(code);
  });

  socket.on("submit-answer", ({ roomCode, answer }) => {
    const code = normalizeRoomCode(roomCode);
    const room = roomStatus[code];
    const playerId = socket.playerId || socket.id;
    const player = roomPlayers[code]?.[playerId];

    if (!room || !player || room.phase !== "question") return;

    const questionIndex = room.currentIndex;
    if (player.answers?.[questionIndex] !== undefined) return;

    if (!player.answers) player.answers = {};
    player.answers[questionIndex] = answer;

    socket.emit("answer-recorded", { questionIndex: questionIndex });
    emitPlayersList(code);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;

    if (socket.isHost) {
      if (socket.playerId) {
        void markParticipantDisconnected({
          roomCode,
          playerToken: socket.playerId,
        });
      }

      clearRoomTimers(roomCode);
      clearRoomPlayerTimers(roomCode);
      if (activeQuizRoomCode === roomCode) {
        activeQuizRoomCode = null;
      }
      io.to(roomCode).emit("host-disconnected", {
        message: "Host disconnected. The room is no longer available.",
      });
      delete roomStatus[roomCode];
      delete roomPlayers[roomCode];
      console.log("Host disconnected, room closed:", roomCode);
      return;
    }

    const playerId = socket.playerId || socket.id;
    const player = roomPlayers[roomCode]?.[playerId];
    if (player) {
      player.connected = false;
      player.socketId = null;
      player.disconnectedAt = Date.now();
      void saveParticipant({
        roomCode,
        playerToken: playerId,
        name: player.name,
        socket,
        isHostPlayer: !!socket.isHost,
      });
      schedulePlayerRemoval(roomCode, playerId);
      io.to(roomCode).emit("player-disconnected", { playerId, name: player.name });
      emitPlayersList(roomCode);
    }

    console.log("User disconnected:", socket.id);
  });
});

app.get("/api/admin/analytics", async (req, res) => {
  try {
    const [totalQuizzes, summary, recentQuizzes] = await Promise.all([
      Leaderboard.countDocuments(),
      Leaderboard.aggregate([
        { $unwind: "$leaderboard" },
        {
          $group: {
            _id: null,
            totalPlayers: { $sum: 1 },
            highestScore: { $max: "$leaderboard.score" },
            totalScores: { $sum: "$leaderboard.score" },
            scoreCount: { $sum: 1 },
          },
        },
      ]),
      Leaderboard.find().sort({ playedAt: -1 }).limit(5),
    ]);

    const stats = summary[0] || {};
    const totalPlayers = stats.totalPlayers || 0;
    const highestScore = stats.highestScore || 0;
    const averageScore =
      !stats.scoreCount ? 0 : (stats.totalScores / stats.scoreCount).toFixed(2);

    res.json({
      totalQuizzes,
      totalPlayers,
      highestScore,
      averageScore,
      recentQuizzes,
    });
  } catch (err) {
    console.warn("Analytics unavailable:", err.message);
    res.json({
      totalQuizzes: 0,
      totalPlayers: 0,
      highestScore: 0,
      averageScore: 0,
      recentQuizzes: [],
    });
  }
});

app.get("/api/admin/participants", async (req, res) => {
  try {
    const roomCode = req.query.roomCode?.toString().trim();
    const query = roomCode ? { roomCode } : {};

    const participants = await QuizParticipant.find(query)
      .sort({ lastSeenAt: -1, joinedAt: -1 })
      .limit(200);

    res.json(participants);
  } catch (err) {
    console.warn("Participant history unavailable:", err.message);
    res.json([]);
  }
});

app.get("/api/admin/questions", async (req, res) => {
  try {
    const roomCode = req.query.roomCode?.toString().trim();
    const query = roomCode ? { roomCode } : {};

    const questions = await QuestionHistory.find(query)
      .sort({ addedAt: -1 })
      .limit(200);

    res.json(questions);
  } catch (err) {
    console.warn("Question history unavailable:", err.message);
    res.json([]);
  }
});

app.get("/api/admin/leaderboards", async (req, res) => {
  try {
    const roomCode = req.query.roomCode?.toString().trim();
    const query = roomCode ? { roomCode } : {};

    const leaderboards = await Leaderboard.find(query)
      .sort({ playedAt: -1 })
      .limit(200);

    res.json(leaderboards);
  } catch (err) {
    console.warn("Leaderboard history unavailable:", err.message);
    res.json([]);
  }
});

app.get("/api/admin/db-collections", async (req, res) => {
  try {
    const  connectionState = mongoose?.connection?.readyState ?? 0;

    if (connectionState !== 1) {
      return res.json({
        quiz_participants: 0,
        quiz_question_history: 0,
        quiz_leaderboards: 0,
        database: mongoose?.connection?.name || null,
        readyState: connectionState,
        connected: false,
      });
    }

    const collections = await Promise.all([
      QuizParticipant.estimatedDocumentCount(),
      QuestionHistory.estimatedDocumentCount(),
      Leaderboard.estimatedDocumentCount(),
    ]);

    res.json({
      quiz_participants: collections[0],
      quiz_question_history: collections[1],
      quiz_leaderboards: collections[2],
      database: mongoose?.connection?.name || null,
      readyState: connectionState,
      connected: connectionState === 1,
    });
  } catch (err) {
    console.warn("DB inspection unavailable:", err.message);
    res.json({
      quiz_participants: 0,
      quiz_question_history: 0,
      quiz_leaderboards: 0,
      database: mongoose?.connection?.name || null,
      readyState: mongoose?.connection?.readyState ?? 0,
      connected: false,
    });
  }
});

app.post("/api/admin/login", (req, res) => {
  const password = req.body?.password?.trim();

  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }

  res.status(401).json({ success: false, message: "Invalid password" });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
