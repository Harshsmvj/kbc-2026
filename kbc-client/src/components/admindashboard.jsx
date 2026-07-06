import { useEffect, useState } from "react";
import "../style/admindashboard.css";

function AdminDashboard() {
  const [data, setData] = useState(null);
  const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || "http://localhost:5000";

  useEffect(() => {
    const isAdminInThisTab = sessionStorage.getItem("isAdmin") === "true";

    if (!isAdminInThisTab) {
      localStorage.removeItem("adminActive");
    }
  }, []);

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/admin/analytics`)
      .then((res) => res.json())
      .then(setData)
      .catch(() =>
        setData({
          totalQuizzes: 0,
          totalPlayers: 0,
          highestScore: 0,
          averageScore: 0,
          recentQuizzes: [],
        })
      );
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

      <h2>Recent Quizzes</h2>

      {data.recentQuizzes.length === 0 ? (
        <p>No quiz history yet (offline mode works without saving).</p>
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
