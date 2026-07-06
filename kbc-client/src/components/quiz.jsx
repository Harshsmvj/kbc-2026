import { useEffect, useState } from "react";
import socket from "../socket";
import "../style/quiz.css";

function Quiz({
  roomCode,
  playerName,
  onQuizEnded: handleQuizEnded,
  initialSync = null,
}) {
  const [sync, setSync] = useState(initialSync);
  const [selected, setSelected] = useState(null);
  const [locked, setLocked] = useState(false);
  const [timeLeft, setTimeLeft] = useState(15);
  const [leaderboard, setLeaderboard] = useState([]);
  const [endedEarly, setEndedEarly] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const onSync = (data) => {
      setSync(data);

      if (data.phase === "question") {
        setSelected(null);
        setLocked(false);
      }
    };

    const onAnswerRecorded = () => {
      setLocked(true);
    };

    const handleQuizEndedEvent = (payload) => {
      const board = Array.isArray(payload?.leaderboard)
        ? payload.leaderboard
        : Array.isArray(payload)
          ? payload
          : [];
      const early = payload?.endedEarly ?? false;

      setLeaderboard(board);
      setEndedEarly(early);
      setFinished(true);
      handleQuizEnded?.(board, early);
    };

    socket.on("quiz-sync", onSync);
    socket.on("answer-recorded", onAnswerRecorded);
    socket.on("quiz-ended", handleQuizEndedEvent);

    return () => {
      socket.off("quiz-sync", onSync);
      socket.off("answer-recorded", onAnswerRecorded);
      socket.off("quiz-ended", handleQuizEndedEvent);
    };
  }, [handleQuizEnded]);

  useEffect(() => {
    if (!sync && initialSync) {
      setSync(initialSync);
    }
  }, [initialSync, sync]);

  useEffect(() => {
    if (!sync || finished) return;

    const tick = () => {
      if (sync.phase === "question" && sync.questionEndsAt) {
        const remaining = Math.ceil((sync.questionEndsAt - Date.now()) / 1000);
        setTimeLeft(Math.max(0, remaining));
      } else if (sync.phase === "reveal") {
        setTimeLeft(0);
      }
    };

    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [sync, finished]);

  const handleClick = (index) => {
    if (!sync || sync.phase !== "question" || locked) return;

    setSelected(index);
    socket.emit("submit-answer", { roomCode, answer: index });
  };

  if (finished) {
    const myScore = leaderboard.find((p) => p.name === playerName)?.score;

    return (
      <div className="quiz-container">
        <h2>{endedEarly ? "Quiz Ended by Host" : "Quiz Finished"}</h2>

        {playerName && myScore !== undefined && (
          <p className="result">
            Your score: {myScore} / {sync?.totalQuestions ?? "?"}
          </p>
        )}

        <h3>Leaderboard</h3>
        <ol className="quiz-leaderboard">
          {leaderboard.map((player, index) => (
            <li key={index}>
              {index + 1}. {player.name} — {player.score}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (!sync || !sync.question) {
    return (
      <div className="quiz-container">
        <h2>Loading quiz...</h2>
      </div>
    );
  }

  const { question, phase, correctAnswer, currentIndex, totalQuestions } = sync;
  const showReveal = phase === "reveal";

  return (
    <div className="quiz-container">
      <div className="quiz-meta">
        <span>
          Question {currentIndex + 1} / {totalQuestions}
        </span>
        <span className="timer">
          {phase === "reveal" ? "Time's up!" : `${timeLeft}s`}
        </span>
      </div>

      <h2 className="question">{question.question}</h2>

      {showReveal && <p className="reveal-banner">Correct answer revealed</p>}

      {question.options.map((opt, index) => {
        let className = "option";

        if (locked && selected === index && !showReveal) {
          className += " selected";
        }

        if (showReveal) {
          if (index === correctAnswer) className += " correct";
          else if (selected === index) className += " wrong";
        }

        return (
          <button
            key={index}
            type="button"
            onClick={() => handleClick(index)}
            className={className}
            disabled={phase !== "question" || locked}
          >
            {opt}
          </button>
        );
      })}

      {locked && phase === "question" && (
        <p className="quiz-hint">Answer locked. Waiting for timer...</p>
      )}
    </div>
  );
}

export default Quiz;
