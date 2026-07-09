import { useEffect, useState } from "react";
import socket from "../socket";
import LiveQuizView from "./LiveQuizView";
import Quiz from "./quiz";
import "../style/admin.css";

const emptyQuestion = {
  question: "",
  options: ["", "", "", ""],
  correct: 0,
};

function Admin({ roomCode }) {
  const [players, setPlayers] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [quizLive, setQuizLive] = useState(false);
  const [quizFinished, setQuizFinished] = useState(false);
  const [finalLeaderboard, setFinalLeaderboard] = useState([]);
  const [hostError, setHostError] = useState("");
  const [newQuestion, setNewQuestion] = useState(emptyQuestion);
  const [hostPlaying, setHostPlaying] = useState(false);
  const [hostPlayerName, setHostPlayerName] = useState("");
  const [joinName, setJoinName] = useState("Host");
  const [questionTime, setQuestionTime] = useState(15);
  const [hostInitialSync, setHostInitialSync] = useState(null);
  const activeRoomCode = roomCode || socket.roomCode || "";

  useEffect(() => {
    const onRoomCreated = ({ questions: initialQuestions, questionTime: initialTime }) => {
      setQuestions(initialQuestions);
      setQuestionTime(initialTime ?? 10);
    };

    const onQuestionsUpdated = (updatedQuestions) => {
      setQuestions(updatedQuestions);
    };

    const onPlayersList = (list) => {
      setPlayers(list);
    };

    const onQuizStartedHost = ({ hostPlaying: playing, questionTime: initialTime, quizSync }) => {
      setQuizLive(true);
      setQuizFinished(false);
      setFinalLeaderboard([]);
      setHostError("");
      setHostPlaying(!!playing);
      setQuestionTime(initialTime ?? 10);
      setHostInitialSync(quizSync ?? null);
    };

    const onQuizResetHost = ({ questions: resetQuestions, questionTime: resetTime }) => {
      setQuizLive(false);
      setQuizFinished(false);
      setFinalLeaderboard([]);
      setQuestions(resetQuestions);
      setHostPlaying(false);
      setHostPlayerName("");
      setHostError("");
      if (resetTime !== undefined) {
        setQuestionTime(resetTime);
      }
      setHostInitialSync(null);
    };

    const onQuizFinished = (leaderboard) => {
      setQuizLive(false);
      setQuizFinished(true);
      setFinalLeaderboard(leaderboard);
    };

    const onQuizEnded = (payload) => {
      const leaderboard = Array.isArray(payload?.leaderboard)
        ? payload.leaderboard
        : Array.isArray(payload)
          ? payload
          : [];

      setQuizLive(false);
      setQuizFinished(true);
      setFinalLeaderboard(leaderboard);
    };

    const onHostJoinSuccess = ({ name, quizStarted, quizSync, questionTime: joinedTime }) => {
      setHostPlaying(true);
      setHostPlayerName(name);
      setHostError("");
      setHostInitialSync(quizSync ?? null);

      if (joinedTime !== undefined) {
        setQuestionTime(joinedTime);
      }

      if (quizStarted) {
        setQuizLive(true);
      }
    };

    const onHostLeaveSuccess = () => {
      setHostPlaying(false);
      setHostPlayerName("");
      setHostInitialSync(null);
    };

    const onHostError = (message) => {
      setHostError(message);
    };

    const onQuestionTimeUpdated = ({ questionTime: updatedTime }) => {
      setQuestionTime(updatedTime);
    };

    socket.on("room-created", onRoomCreated);
    socket.on("questions-updated", onQuestionsUpdated);
    socket.on("players-list", onPlayersList);
    socket.on("quiz-started-host", onQuizStartedHost);
    socket.on("quiz-reset-host", onQuizResetHost);
    socket.on("quiz-finished", onQuizFinished);
    socket.on("quiz-ended", onQuizEnded);
    socket.on("host-join-success", onHostJoinSuccess);
    socket.on("host-leave-success", onHostLeaveSuccess);
    socket.on("host-error", onHostError);
    socket.on("question-time-updated", onQuestionTimeUpdated);

    return () => {
      socket.off("room-created", onRoomCreated);
      socket.off("questions-updated", onQuestionsUpdated);
      socket.off("players-list", onPlayersList);
      socket.off("quiz-started-host", onQuizStartedHost);
      socket.off("quiz-reset-host", onQuizResetHost);
      socket.off("quiz-finished", onQuizFinished);
      socket.off("quiz-ended", onQuizEnded);
      socket.off("host-join-success", onHostJoinSuccess);
      socket.off("host-leave-success", onHostLeaveSuccess);
      socket.off("host-error", onHostError);
      socket.off("question-time-updated", onQuestionTimeUpdated);
    };
  }, []);

  const updateNewQuestion = (field, value) => {
    setNewQuestion((prev) => ({ ...prev, [field]: value }));
  };

  const updateOption = (index, value) => {
    setNewQuestion((prev) => {
      const options = [...prev.options];
      options[index] = value;
      return { ...prev, options };
    });
  };

  const handleAddQuestion = () => {
    setHostError("");
    if (!activeRoomCode) {
      setHostError("Room is still being created. Try again in a moment.");
      return;
    }

    setQuestions((currentQuestions) => [
      ...currentQuestions,
      {
        question: newQuestion.question.trim(),
        options: newQuestion.options.map((option) => option.trim()),
        correct: newQuestion.correct,
      },
    ]);

    socket.emit("add-question", { roomCode: activeRoomCode, question: newQuestion });
    setNewQuestion(emptyQuestion);
  };

  const handleRemoveQuestion = (index) => {
    setHostError("");
    socket.emit("remove-question", { roomCode: activeRoomCode, index });
  };

  const handleKickPlayer = (targetPlayerId) => {
    setHostError("");
    socket.emit("kick-player", { roomCode: activeRoomCode, targetPlayerId });
  };

  const handleStartQuiz = () => {
    setHostError("");
    socket.emit("start-quiz", activeRoomCode);
  };

  const handleEndQuiz = () => {
    setHostError("");
    socket.emit("end-quiz", activeRoomCode);
  };

  const handleStartNewQuiz = () => {
    setHostError("");
    socket.emit("start-new-quiz", activeRoomCode);
  };

  const handleJoinAsPlayer = () => {
    setHostError("");
    socket.emit("host-join-as-player", { roomCode: activeRoomCode, name: joinName });
  };

  const handleLeaveAsPlayer = () => {
    setHostError("");
    socket.emit("host-leave-quiz", activeRoomCode);
  };

  const handleApplyQuestionTime = () => {
    setHostError("");
    socket.emit("set-question-time", { roomCode: activeRoomCode, questionTime });
  };

  const canEditQuestions = !quizLive && !quizFinished;

  return (
    <div className="admin-layout">
      {quizLive && hostPlaying && (
        <Quiz roomCode={roomCode} playerName={hostPlayerName} initialSync={hostInitialSync} />
      )}

      {quizLive && !hostPlaying && <LiveQuizView roomCode={roomCode} />}

      <div className="admin-container">
        <h2>Host Control Panel</h2>
        <p className="admin-subtitle">One quiz at a time. You can spectate or play.</p>

        {activeRoomCode ? (
          <p>
            <strong>Room Code:</strong> <span className="admin-room-code">{activeRoomCode}</span>
          </p>
        ) : (
          <p>Creating room...</p>
        )}

        {hostError && <p className="admin-error">{hostError}</p>}

        <section className="admin-section">
          <h3>Question Timer</h3>
          <div className="admin-timer-row">
            <input
              type="number"
              min="5"
              max="300"
              value={questionTime}
              onChange={(e) => setQuestionTime(e.target.value)}
            />
            <button type="button" className="admin-btn-secondary" onClick={handleApplyQuestionTime}>
              Apply Timer
            </button>
          </div>
          <p className="admin-muted">
            Changing this updates the current room and can take effect during a live quiz.
          </p>
        </section>

        {quizLive && (
          <div className="admin-status admin-status-live">
            Quiz is live - synced timer running for all players.
          </div>
        )}

        {quizFinished && (
          <div className="admin-status admin-status-finished">
            Quiz finished. Review the leaderboard below.
          </div>
        )}

        {!quizLive && !quizFinished && !hostPlaying && (
          <section className="admin-section admin-join-section">
            <h3>Join as Player (optional)</h3>
            <p className="admin-muted">
              Join before or during the quiz if you want to play along with everyone else.
            </p>
            <input
              placeholder="Your name in the quiz"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
            />
            <button type="button" className="admin-btn-secondary" onClick={handleJoinAsPlayer}>
              Join as Player
            </button>
          </section>
        )}

        {!quizLive && !quizFinished && hostPlaying && (
          <section className="admin-section">
            <p className="admin-muted">
              You are joined as <strong>{hostPlayerName}</strong>.
            </p>
            <button type="button" className="admin-btn-secondary" onClick={handleLeaveAsPlayer}>
              Stop Playing
            </button>
          </section>
        )}

        <section className="admin-section">
          <h3>Players ({players.length})</h3>
          {players.length === 0 ? (
            <p className="admin-muted">No players yet. Join as player or wait for others.</p>
          ) : (
            <ul className="admin-player-list">
              {players.map((player) => (
                <li key={player.playerId || player.socketId}>
                  <span>
                    {player.name}
                    {player.name === hostPlayerName ? " (you)" : ""}
                    {quizLive || quizFinished ? ` - ${player.score} pts` : ""}
                    {quizLive && player.answeredCurrent ? " ✓" : ""}
                    {!player.connected ? " · reconnecting" : ""}
                  </span>
                  {player.name !== hostPlayerName && (
                    <button
                      type="button"
                      className="admin-btn-danger"
                      onClick={() => handleKickPlayer(player.playerId || player.socketId)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {canEditQuestions && (
          <section className="admin-section">
            <h3>Quiz Questions ({questions.length})</h3>
            <ul className="admin-question-list">
              {questions.map((q, index) => (
                <li key={index}>
                  <div>
                    <strong>Q{index + 1}.</strong> {q.question}
                    <div className="admin-muted">Answer: {q.options[q.correct]}</div>
                  </div>
                  <button
                    type="button"
                    className="admin-btn-danger"
                    onClick={() => handleRemoveQuestion(index)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>

            <div className="admin-add-question">
              <h4>Add Question</h4>
              <input
                placeholder="Question text"
                value={newQuestion.question}
                onChange={(e) => updateNewQuestion("question", e.target.value)}
              />
              {newQuestion.options.map((opt, index) => (
                <div key={index} className="admin-option-row">
                  <label>
                    <input
                      type="radio"
                      name="correct"
                      checked={newQuestion.correct === index}
                      onChange={() => updateNewQuestion("correct", index)}
                    />
                    Option {index + 1}
                  </label>
                  <input
                    placeholder={`Option ${index + 1}`}
                    value={opt}
                    onChange={(e) => updateOption(index, e.target.value)}
                  />
                </div>
              ))}
              <button type="button" className="admin-btn-secondary" onClick={handleAddQuestion}>
                Add Question
              </button>
            </div>
          </section>
        )}

        {quizFinished && finalLeaderboard.length > 0 && (
          <section className="admin-section">
            <h3>Leaderboard</h3>
            <ol className="admin-leaderboard">
              {finalLeaderboard.map((player, index) => (
                <li key={index}>
                  {index + 1}. {player.name} - {player.score}
                </li>
              ))}
            </ol>
          </section>
        )}

        <div className="admin-actions">
          {!quizLive && !quizFinished && (
            <button
              type="button"
              disabled={!activeRoomCode || questions.length === 0}
              onClick={handleStartQuiz}
            >
              Start Quiz
            </button>
          )}

          {quizLive && (
            <button type="button" className="admin-btn-end" onClick={handleEndQuiz}>
              End Quiz Now
            </button>
          )}

          {quizFinished && (
            <button type="button" disabled={!activeRoomCode} onClick={handleStartNewQuiz}>
              Start New Quiz
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default Admin;
