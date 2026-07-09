import { useEffect, useState } from "react";
import socket from "../socket";
import "../style/admindashboard.css";

function AdminDashboard() {
  const [data, setData] = useState(null);
  const [dbInfo, setDbInfo] = useState(null);
  const [loadError, setLoadError] = useState("");
  const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || "http://localhost:5000";

  useEffect(() => {
    const isAdminInThisTab = sessionStorage.getItem("isAdmin") === "true";

    if (!isAdminInThisTab) {
      localStorage.removeItem("adminActive");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadDashboard = async () => {
      try {
        const [analyticsResponse, dbResponse] = await Promise.all([
          fetch(`${apiBaseUrl}/api/admin/analytics`),
          fetch(`${apiBaseUrl}/api/admin/db-collections`),
        ]);

        const analyticsData = analyticsResponse.ok
          ? await analyticsResponse.json()
          : {
              totalQuizzes: 0,
              totalPlayers: 0,
              highestScore: 0,
              averageScore: 0,
              recentQuizzes: [],
            };

        const databaseData = dbResponse.ok ? await dbResponse.json() : null;

        if (cancelled) return;

        setData(analyticsData);
        setDbInfo(databaseData);
        setLoadError(analyticsResponse.ok ? "" : "Analytics could not be loaded from the server.");
      } catch {
        if (cancelled) return;

        setData({
          totalQuizzes: 0,
          totalPlayers: 0,
          highestScore: 0,
          averageScore: 0,
          recentQuizzes: [],
        });
        setDbInfo(null);
        setLoadError("Server is unavailable or MongoDB is not connected.");
      }
    };

    const handleDbUpdate = () => {
      void loadDashboard();
    };

    loadDashboard();
    socket.on("admin-db-updated", handleDbUpdate);

    const pollInterval = setInterval(() => {
      if (socket.connected) {
        void loadDashboard();
      }
    }, 10000);

    return () => {
      cancelled = true;
      socket.off("admin-db-updated", handleDbUpdate);
      clearInterval(pollInterval);
    };
  }, [apiBaseUrl]);

  const handleLogout = () => {
    sessionStorage.removeItem("isAdmin");
    localStorage.removeItem("adminActive");
    window.location.reload();
  };

  if (!data) {
    return <h2>Loading analytics...</h2>;
  }

  return (
    <div className="dashboard-container" style={{ padding: "40px" }}>
      <div className="dashboard-header">
        <h1>Admin Analytics</h1>
        <button type="button" onClick={handleLogout}>
          Logout
        </button>
      </div>

      <div className="dashboard-stats" style={{ display: "flex", gap: "20px", marginBottom: "30px" }}>
        <Stat title="Total Quizzes" value={data.totalQuizzes} />
        <Stat title="Total Players" value={data.totalPlayers} />
        <Stat title="Highest Score" value={data.highestScore} />
        <Stat title="Avg Score" value={data.averageScore} />
      </div>

      {dbInfo && (
        <p className="admin-muted">
          Mongo status: {dbInfo.connected ? "connected" : "not connected"}. Saved records: {dbInfo.quiz_leaderboards || 0} quizzes, {dbInfo.quiz_question_history || 0} questions, {dbInfo.quiz_participants || 0} participants.
        </p>
      )}

      {loadError && <p className="player-error">{loadError}</p>}

      <h2>Recent Quizzes</h2>

      {data.recentQuizzes.length === 0 ? (
        <p>
          {dbInfo?.connected
            ? "No quiz history yet. Finish a quiz once and the leaderboard will appear here."
            : "MongoDB is not connected, so quiz history cannot be saved yet."}
        </p>
      ) : (
        <table className="dashboard-table" border="1" cellPadding="10">
          <thead>
            <tr>
              <th>Room</th>
              <th>Date</th>
              <th>Top Score</th>
              <th>Players</th>
            </tr>
          </thead>
          <tbody>
            {data.recentQuizzes.map((quiz, i) => (
              <tr key={i}>
                <td>{quiz.roomCode}</td>
                <td>{new Date(quiz.playedAt).toLocaleString()}</td>
                <td>{quiz.leaderboard[0]?.score ?? 0}</td>
                <td>{quiz.leaderboard.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ title, value }) {
  return (
    <div
      style={{
        border: "1px solid #ccc",
        padding: "20px",
        minWidth: "150px",
        textAlign: "center",
      }}
    >
      <h3>{title}</h3>
      <p style={{ fontSize: "24px" }}>{value}</p>
    </div>
  );
}

export default AdminDashboard;
