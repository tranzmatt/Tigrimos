import { useState } from "react";
import Terminal from "../components/Terminal";

export default function TerminalPage() {
  const [key, setKey] = useState(0);
  const [closed, setClosed] = useState(false);

  return (
    <div style={{ padding: 16, height: "100%", display: "flex", flexDirection: "column" }}>
      {closed ? (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", flex: 1, gap: 12,
        }}>
          <span style={{ color: "#8b949e", fontSize: 14 }}>Terminal session ended</span>
          <button
            onClick={() => { setClosed(false); setKey(k => k + 1); }}
            style={{
              background: "#238636", color: "#fff", border: "none", borderRadius: 6,
              padding: "8px 20px", cursor: "pointer", fontSize: 13,
            }}
          >
            Reconnect
          </button>
        </div>
      ) : (
        <Terminal key={key} onClose={() => setClosed(true)} />
      )}
    </div>
  );
}
