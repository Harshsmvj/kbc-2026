import { useEffect, useState } from "react";
import socket from "../socket";
import "../style/quiz.css";

function LiveQuizView({ roomCode }) {
  const [sync, setSync] = useState(null);
  const [players, setPlayers] = useState([]);
  const [timeLeft, setTimeLeft] = useState(15);

  useEffect(() => {
    const onSyncHost = (data) => {
      setSync(data);
      if (data.players) setPlayers(data.players);
    };

    const onSync = (data) => {
      setSync((prev) => ({ ...prev, ...data }));
    };

    socket.on("quiz-sync-host", onSyncHost);
    socket.on("quiz-sync", onSync);

    return () => {
      socket.off("quiz-sync-host", onSyncHost);
      socket.off("quiz-sync", onSync);
    };
  }, []);

  useEffect(() => {
    if (!sync) return;

    const tick = () => {
      if (sync.phase === "question" && sync.questionEndsAt) {
        const remaining = Math.ceil((sync.questionEndsAt - Date.now()) / 1000);
        setTimeLeft(Math.max(0, remaining));
      } else {
        setTimeLeft(0);
      }
    };

    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [sync]);

  if (!sync || !sync.question) {
    return (
      <div className="live-quiz-view">
        <h3>Live Quiz</h3>
        <p className="admin-muted">Waiting for quiz data...</p>
      </div>
    );
  }

  const { question, phase, correctAnswer, currentIndex, totalQuestions } = sync;
  const showReveal = phase === "reveal";

  return (
    <div className="live-quiz-view">
      <h3>Live Quiz</h3>

      <div className="quiz-meta">
        <span>
          Q{currentIndex + 1} / {totalQuestions}
        </span>
        <span className="timer">
          {phase === "reveal" ? "Revealing answer..." : `${timeLeft}s`}
        </span>
      </div>

      <p className="live-question">{question.question}</p>

      <div className="live-options">
        {question.options.map((opt, index) => {
          let className = "live-option";
          if (showReveal && index === correctAnswer) className += " correct";
          return (
            <div key={index} className={className}>
              {String.fromCharCode(65 + index)}. {opt}
            </div>
          );
        })}
      </div>

      <div className="live-players">
        <h4>Players</h4>
        <ul>
          {players.map((p) => (
            <li key={p.socketId}>
              {p.name} — {p.score} pts
              {phase === "question" && (
                <span className="live-answered">
                  {p.answeredCurrent ? " ✓ answered" : " · waiting"}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default LiveQuizView;
