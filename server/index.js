require("./db");
const Leaderboard = require("./leaderboard");
const defaultQuestions = require("./question");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const ADMIN_PASSWORD = "kbc_admin_123";
const DEFAULT_QUESTION_TIME = 15;
const REVEAL_TIME = 3;
const PORT = Number.parseInt(process.env.PORT, 10) || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

const roomStatus = {};
const roomPlayers = {};
const roomTimers = {};
let activeQuizRoomCode = null;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

const cloneQuestions = (questions) =>
  questions.map((q) => ({
    question: q.question,
    options: [...q.options],
    correct: q.correct,
  }));

const sanitizeQuestions = (questions) =>
  questions.map(({ question, options }) => ({ question, options }));

const normalizeRoomCode = (roomCode) => String(roomCode).trim();

const isValidRoomCode = (roomCode) => /^\d{6}$/.test(normalizeRoomCode(roomCode));

const isHost = (socket, roomCode) =>
  roomStatus[normalizeRoomCode(roomCode)]?.hostSocketId === socket.id;

const getPlayersList = (roomCode) => {
  const room = roomStatus[roomCode];
  const players = roomPlayers[roomCode];
  if (!players) return [];

  return Object.entries(players).map(([id, player]) => ({
    socketId: id,
    name: player.name,
    score: player.score,
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

const buildSyncPayload = (roomCode) => {
  const room = roomStatus[roomCode];
  const question = room.questions[room.currentIndex];
  const elapsed = Math.floor((Date.now() - room.questionStartedAt) / 1000);
  const timeLeft = Math.max(0, room.questionTime - elapsed);

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
  void saveLeaderboard(roomCode, leaderboard, room.questions.length);

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
    });
  }
};

const saveLeaderboard = async (roomCode, leaderboardData, totalQuestions) => {
  try {
    await Leaderboard.create({
      roomCode,
      leaderboard: leaderboardData,
      totalQuestions,
    });
  } catch (err) {
    console.warn("Leaderboard save skipped (offline mode):", err.message);
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

  socket.on("create-room", () => {
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

    roomStatus[roomCode] = {
      started: false,
      phase: "lobby",
      currentIndex: 0,
      hostSocketId: socket.id,
      hostPlaying: false,
      questionTime: DEFAULT_QUESTION_TIME,
      questions: cloneQuestions(defaultQuestions),
    };

    roomPlayers[roomCode] = {};

    console.log("Room created:", roomCode);

    socket.emit("room-created", {
      roomCode,
      questions: roomStatus[roomCode].questions,
      questionTime: roomStatus[roomCode].questionTime,
    });
    emitPlayersList(roomCode);
  });

  socket.on("join-room", ({ roomCode, name }) => {
    const code = normalizeRoomCode(roomCode);
    const trimmedName = name?.trim();

    if (!trimmedName) {
      socket.emit("join-error", "Enter your name to join.");
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

    const existingNames = Object.values(roomPlayers[code] || {}).map((p) =>
      p.name.toLowerCase()
    );
    if (existingNames.includes(trimmedName.toLowerCase())) {
      socket.emit("join-error", "That name is already taken in this room.");
      return;
    }

    socket.join(code);
    socket.roomCode = code;

    if (!roomPlayers[code]) {
      roomPlayers[code] = {};
    }

    roomPlayers[code][socket.id] = {
      name: trimmedName,
      score: 0,
      answers: {},
    };

    const quizSync = room.started ? buildSyncPayload(code) : null;

    console.log(trimmedName, "joined room", code);

    socket.emit("join-success", {
      roomCode: code,
      questions: room.questions,
      quizStarted: room.started,
      quizSync,
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
    };
    room.hostPlaying = true;

    const quizSync = room.started ? buildSyncPayload(code) : null;

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
    room.hostPlaying = false;
    socket.emit("host-leave-success");
    emitPlayersList(code);
  });

  socket.on("add-question", ({ roomCode, question }) => {
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

    room.questions.push({
      question: question.question.trim(),
      options: question.options.map((opt) => opt.trim()),
      correct: question.correct,
    });

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

  socket.on("remove-question", ({ roomCode, index }) => {
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

    room.questions.splice(index, 1);
    emitQuestionsUpdated(roomCode);
  });

  socket.on("kick-player", ({ roomCode, targetSocketId }) => {
    if (!isHost(socket, roomCode)) {
      socket.emit("host-error", "Only the host can remove players.");
      return;
    }

    const room = roomStatus[roomCode];
    if (targetSocketId === room?.hostSocketId) {
      socket.emit("host-error", "Use 'Stop Playing' to leave the quiz yourself.");
      return;
    }

    const player = roomPlayers[roomCode]?.[targetSocketId];
    if (!player) {
      socket.emit("host-error", "Player not found.");
      return;
    }

    io.to(targetSocketId).emit("kicked", {
      message: "You were removed from the quiz by the host.",
    });

    delete roomPlayers[roomCode][targetSocketId];

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.leave(roomCode);
      delete targetSocket.roomCode;
    }

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

    const playerCount = Object.keys(roomPlayers[code] || {}).length;
    if (playerCount === 0) {
      socket.emit("host-error", "Wait for at least one player to join (or join as player).");
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
    const player = roomPlayers[code]?.[socket.id];

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
      clearRoomTimers(roomCode);
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

    const player = roomPlayers[roomCode]?.[socket.id];
    if (player) {
      delete roomPlayers[roomCode][socket.id];
      io.to(roomCode).emit("player-left", player.name);
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
