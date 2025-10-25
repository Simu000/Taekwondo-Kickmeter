import React, { useEffect, useState } from "react";
// Firebase
import { initializeApp, getApps } from "firebase/app";
import { getDatabase, ref, onValue, set, push } from "firebase/database";
import { getAuth, signInAnonymously } from "firebase/auth";
// Import the Chatbot
import TaekwondoChatbot from "./TaekwondoChatbot";

export default function KickData() {
  const [data, setData] = useState([]);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const [seenIds, setSeenIds] = useState(new Set());
  const [isSessionComplete, setIsSessionComplete] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [sessionHistory, setSessionHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  // Firebase config
  const firebaseConfig = {
    apiKey:
      import.meta.env.VITE_FIREBASE_API_KEY ||
      "AIzaSyAH_xHcxUoNF4PHHq5Kzo20lNxSsZ9a2uM",
    authDomain:
      import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ||
      "taekwondo-kick-meter.firebaseapp.com",
    databaseURL:
      import.meta.env.VITE_FIREBASE_DATABASE_URL ||
      "https://taekwondo-kick-meter-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId:
      import.meta.env.VITE_FIREBASE_PROJECT_ID || "taekwondo-kick-meter",
    storageBucket:
      import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ||
      "taekwondo-kick-meter.firebasestorage.app",
    messagingSenderId:
      import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "364072538317",
    appId:
      import.meta.env.VITE_FIREBASE_APP_ID ||
      "1:364072538317:web:621b5aa5dffcc36274d984",
  };

  let app;
  if (!getApps().length) {
    app = initializeApp(firebaseConfig);
  } else {
    app = getApps()[0];
  }
  const db = getDatabase(app);
  const auth = getAuth(app);
  const [authReady, setAuthReady] = useState(false);

  // Load session history
  useEffect(() => {
    if (!authReady) return;

    const historyRef = ref(db, "session_history");
    const unsubscribe = onValue(historyRef, (snapshot) => {
      const historyData = snapshot.val();
      if (historyData) {
        const sessions = Object.entries(historyData).map(([id, session]) => ({
          id,
          ...session
        })).sort((a, b) => b.timestamp - a.timestamp); // Sort by latest first
        setSessionHistory(sessions);
      }
    });

    return () => unsubscribe();
  }, [authReady]);

  const saveSessionToHistory = async (sessionData, chatbotResponse) => {
    if (!authReady) return;

    try {
      const sessionRef = push(ref(db, "session_history"));
      await set(sessionRef, {
        timestamp: Date.now(),
        kickData: sessionData,
        chatbotResponse: chatbotResponse,
        totalKicks: sessionData.length,
        date: new Date().toLocaleString()
      });
      console.log("Session saved to history");
    } catch (error) {
      console.error("Error saving session to history:", error);
    }
  };

  const fixTimestamp = (timestamp) => {
    if (!timestamp) return null;
    // If numeric string
    if (!isNaN(Number(timestamp))) return Number(timestamp);
    // Try ISO parse
    const parsed = Date.parse(timestamp);
    if (!isNaN(parsed)) return parsed;
    // Try small normalization: replace D with - and spaces with T
    try {
      const t = String(timestamp).replace(/D/g, "-").replace(/\s+/g, "T");
      const p = Date.parse(t);
      if (!isNaN(p)) return p;
    } catch (e) {
      // ignore
    }
    return null;
  };

  const handleSnapshotJson = (json) => {
    try {
      if (!json) return;
      const allKicks = Object.entries(json).map(([id, value]) => {
        const rawTs = value.timestamp_utc || value.timestamp || value.time;
        const ts = fixTimestamp(rawTs);
        return {
          id,
          ...value,
          _timestamp_ms: ts,
          // keep original for display fallback
          timestamp_utc: rawTs,
        };
      });

      // sort ascending by timestamp
      allKicks.sort((a, b) => (a._timestamp_ms || 0) - (b._timestamp_ms || 0));

      const now = Date.now();
      const allowedSkewMs = 5000; // 5s
      const maxAgeMs = 30 * 60 * 1000; // 30 minutes

      const recentUnseen = allKicks.find((kick) => {
        if (!kick.id) return false;
        if (seenIds.has(kick.id)) return false;
        const ts = kick._timestamp_ms;
        if (!ts) return false;
        // ignore very old logs
        if (ts < now - maxAgeMs) return false;
        // if session started, only accept kicks after sessionStartTime (allow small skew)
        if (sessionStartTime && ts < sessionStartTime - allowedSkewMs) return false;
        return true;
      });

      if (recentUnseen) {
        setData((prevData) => {
          if (prevData.length < 10) {
            const newData = [...prevData, recentUnseen];
            if (newData.length === 10) {
              setIsSessionComplete(true);
              setListening(false);
            }
            return newData;
          }
          return prevData;
        });

        setSeenIds((prevIds) => {
          const newSet = new Set(prevIds);
          newSet.add(recentUnseen.id);
          return newSet;
        });
      }
    } catch (err) {
      console.error("Snapshot processing error:", err);
      setError("Failed to process data: " + err.message);
      setListening(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    signInAnonymously(auth)
      .then(() => {
        if (!mounted) return;
        setAuthReady(true);
      })
      .catch((err) => {
        console.error("Firebase auth error:", err);
        setError("Auth error: " + err.message);
        setAuthReady(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!listening) return;
    if (!authReady) return;

    const kicksRef = ref(db, "kick_data");
    const unsubscribe = onValue(
      kicksRef,
      (snapshot) => {
        const json = snapshot.val();
        handleSnapshotJson(json);
      },
      (err) => {
        console.error("Realtime DB listener error:", err);
        setError("Failed to read realtime DB: " + err.message);
        setListening(false);
      }
    );

    return () => unsubscribe();
  }, [listening, seenIds, authReady]);

  const handleStart = () => {
    setData([]);
    setError(null);
    setSeenIds(new Set());
    setIsSessionComplete(false);
    setListening(true);
    setSessionStartTime(Date.now());
    setShowHistory(false);
  };

  const handleStop = () => {
    setListening(false);
    if (data.length === 10) {
      setIsSessionComplete(true);
    }
  };

  // Edge pressure threshold (percentage)
  const EDGE_PRESSURE_THRESHOLD = 10; // percent

  const getAccuracyValue = (item) => {
    // try several possible fields, prefer numeric percentage
    const candidates = [
      item?.accuracy_percentage,
      item?.accuracy,
      item?.accuracyPercent,
      item?.accuracy_percent,
    ];
    for (const c of candidates) {
      if (c == null) continue;
      const n = Number(c);
      if (!isNaN(n)) return n;
      // if it's a string like '85%'
      const m = String(c).replace('%', '').trim();
      const p = Number(m);
      if (!isNaN(p)) return p;
    }
    return null;
  };

  const getAccuracyBadge = (item) => {
    const acc = getAccuracyValue(item);
    const edge = Number(item?.pressure_at_edges_in_percentage);
    const isEdge = !isNaN(edge) && edge > EDGE_PRESSURE_THRESHOLD;

    // Consider lower accuracy when edge hits are present or accuracy < 90
    const lowAccuracy = (acc == null ? false : acc < 90) || isEdge;

    if (lowAccuracy) {
      return "bg-yellow-900/50 text-yellow-400 border-yellow-700";
    } else {
      return "bg-green-900/50 text-green-400 border-green-700";
    }
  };

  const getAccuracyLabel = (item) => {
    // Primary driver: edge pressure
    const edge = Number(item?.pressure_at_edges_in_percentage);
    if (!isNaN(edge)) {
      return edge < EDGE_PRESSURE_THRESHOLD ? 'Higher accuracy' : 'Lower accuracy';
    }

    // Fallback to numeric accuracy if edge not available
    const acc = getAccuracyValue(item);
    if (acc != null) return acc >= 90 ? 'Higher accuracy' : 'Lower accuracy';

    // If nothing available, return 'N/A'
    return 'N/A';
  };

  const getForceKg = (item) => {
    // prefer a provided kg value
    const kg = item?.force_of_kick_in_kilograms;
    if (kg != null && !isNaN(Number(kg))) return Number(kg);
    // fallback: convert from newton to kg (approx)
    const n = item?.force_of_kick_in_newton;
    if (n != null && !isNaN(Number(n))) return Number(n) / 9.81;
    return null;
  };

  const getKickType = (item) => {
    const kg = getForceKg(item);
    // Define thresholds (kg). Use continuous ranges so every kick maps to Light/Medium/Hard.
    // User-specified: 4-6 Light, 7-8 Medium, >8 Hard â€” we'll make <=6 Light, >6 && <=8 Medium, >8 Hard.
    if (kg == null || !isFinite(kg)) {
      // fallback: if no force, try to infer from speed (very rough): >7 m/s => Hard, >5 => Medium, else Light
      const sp = item?.speed_of_kick_in_meters_per_second;
      const s = sp != null && !isNaN(Number(sp)) ? Number(sp) : null;
      if (s != null) {
        if (s > 7) return 'Hard';
        if (s > 5) return 'Medium';
        return 'Light';
      }
      // final fallback -> classify as Light to avoid 'Unknown'
      return 'Light';
    }

    if (kg <= 6) return 'Light';
    if (kg > 6 && kg <= 8) return 'Medium';
    return 'Hard';
  };

  return (
    <div className="bg-gradient-to-br from-gray-950 to-black text-gray-200 min-h-screen font-sans">
      <style>
        {`
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes slideUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes pulse-glow {
            0% { box-shadow: 0 0 5px rgba(255,255,255,0.2); }
            50% { box-shadow: 0 0 20px rgba(255,255,255,0.6); }
            100% { box-shadow: 0 0 5px rgba(255,255,255,0.2); }
          }
          .animate-fadeIn { animation: fadeIn 0.8s ease-in-out; }
          .animate-slideUp { animation: slideUp 0.6s ease-out; }
          .animate-pulse-glow { animation: pulse-glow 3s infinite ease-in-out; }
        `}
      </style>

      <div className="max-w-6xl mx-auto py-12 px-6">
        <header className="text-center mb-16 animate-fadeIn">
          <h1 className="text-5xl md:text-7xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-gray-300 via-gray-500 to-gray-300 tracking-tight drop-shadow-lg">
            Taekwondo Kick Master
          </h1>
          <p className="text-lg md:text-xl text-gray-500 mt-4 font-light">
            Sleek Performance Metrics with AI Coach
          </p>
        </header>

        <div className="mb-12 text-center animate-slideUp">
          <div className="flex justify-center gap-4 mb-6">
            {!listening && !showHistory && (
              <button
                onClick={handleStart}
                className="group relative inline-flex items-center justify-center px-10 py-4 text-lg font-bold text-gray-900 transition-all duration-500 ease-in-out rounded-full overflow-hidden shadow-xl hover:shadow-gray-700/50 transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-gray-600 focus:ring-opacity-75"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #A7A8AA 0%, #E6E7E9 50%, #A7A8AA 100%)",
                }}
              >
                <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-gray-500 via-gray-600 to-gray-500 opacity-0 transition-opacity duration-300 group-hover:opacity-100"></span>
                <span className="relative z-10">Start New Session</span>
              </button>
            )}

            {!listening && (
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="group relative inline-flex items-center justify-center px-8 py-4 text-lg font-bold text-white transition-all duration-500 ease-in-out rounded-full overflow-hidden shadow-xl hover:shadow-blue-900/50 transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-blue-600 focus:ring-opacity-75"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #1E3A8A 0%, #3B82F6 50%, #1E3A8A 100%)",
                }}
              >
                <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-blue-600 via-blue-700 to-blue-600 opacity-0 transition-opacity duration-300 group-hover:opacity-100"></span>
                <span className="relative z-10">
                  {showHistory ? 'Back to Current' : 'View Session History'}
                </span>
              </button>
            )}
          </div>

          {listening && (
            <div className="flex items-center justify-center space-x-6">
              <button
                onClick={handleStop}
                className="group relative inline-flex items-center justify-center px-10 py-4 text-lg font-bold text-white transition-all duration-500 ease-in-out rounded-full overflow-hidden shadow-xl hover:shadow-red-900/50 transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-red-600 focus:ring-opacity-75"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #470D0D 0%, #B91C1C 50%, #470D0D 100%)",
                }}
              >
                <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-red-600 via-red-700 to-red-600 opacity-0 transition-opacity duration-300 group-hover:opacity-100"></span>
                <span className="relative z-10">Stop Collection</span>
              </button>
              <span className="text-red-500 font-semibold text-xl animate-pulse-glow flex items-center space-x-2">
                <span className="relative flex h-4 w-4">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500"></span>
                </span>
                <span>Live - Collecting Kicks... ({data.length}/10)</span>
              </span>
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-900 text-red-300 p-6 rounded-xl border border-red-800 shadow-xl mb-12 animate-fadeIn">
            <strong className="font-bold">Error:</strong> {error}
          </div>
        )}

        {showHistory ? (
          <div className="mb-16">
            <h3 className="text-3xl font-bold text-gray-400 mb-6 border-b border-gray-800 pb-4">
              Session History ({sessionHistory.length} sessions)
            </h3>
            {sessionHistory.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                No previous sessions found. Complete a session to see it here!
              </div>
            ) : (
              <div className="space-y-6">
                {sessionHistory.map((session, index) => (
                  <div
                    key={session.id}
                    className="bg-gray-900 p-6 rounded-2xl shadow-2xl border border-gray-800 transition-all duration-300 hover:border-gray-600"
                  >
                    <div className="flex justify-between items-center mb-4">
                      <h4 className="text-xl font-bold text-gray-100">
                        Session {sessionHistory.length - index} - {session.date}
                      </h4>
                      <span className="text-sm text-gray-400">
                        {session.totalKicks} kicks
                      </span>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                      <div className="bg-gray-800 p-3 rounded-lg">
                        <div className="text-sm text-gray-400">Avg Force</div>
                        <div className="text-lg font-bold text-gray-200">
                          {session.kickData && session.kickData.length > 0 ? 
                            (session.kickData.reduce((sum, kick) => {
                              const force = getForceKg(kick);
                              return sum + (force || 0);
                            }, 0) / session.kickData.length).toFixed(1) + ' kg' : 'N/A'
                          }
                        </div>
                      </div>
                      <div className="bg-gray-800 p-3 rounded-lg">
                        <div className="text-sm text-gray-400">Avg Speed</div>
                        <div className="text-lg font-bold text-gray-200">
                          {session.kickData && session.kickData.length > 0 ? 
                            (session.kickData.reduce((sum, kick) => {
                              const speed = Number(kick.speed_of_kick_in_meters_per_second);
                              return sum + (isNaN(speed) ? 0 : speed);
                            }, 0) / session.kickData.length).toFixed(1) + ' m/s' : 'N/A'
                          }
                        </div>
                      </div>
                      <div className="bg-gray-800 p-3 rounded-lg">
                        <div className="text-sm text-gray-400">Session Date</div>
                        <div className="text-sm font-bold text-gray-200">
                          {new Date(session.timestamp).toLocaleDateString()}
                        </div>
                      </div>
                    </div>

                    {session.chatbotResponse && (
                      <div className="mt-4 p-4 bg-gray-800 rounded-lg border border-gray-700">
                        <div className="text-sm text-gray-400 mb-2">Coach's Analysis:</div>
                        <div className="text-gray-300 text-sm whitespace-pre-line">
                          {session.chatbotResponse.length > 200 
                            ? session.chatbotResponse.substring(0, 200) + '...' 
                            : session.chatbotResponse
                          }
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : data.length > 0 && (
          <div className="mb-16">
            <h3 className="text-3xl font-bold text-gray-400 mb-6 border-b border-gray-800 pb-4">
              Live Kick Data ({data.length}/10)
            </h3>
            <div className="space-y-6 max-h-[600px] overflow-y-auto pr-2">
              {data.map((item, index) => (
                <div
                  key={item.id}
                  className="bg-gray-900 p-8 rounded-2xl shadow-2xl border border-gray-800 transition-all duration-500 ease-in-out transform hover:scale-[1.01] hover:border-gray-700 animate-slideUp"
                >
                  <div className="flex justify-between items-center mb-4 pb-4 border-b border-gray-800">
                    <h4 className="text-2xl font-extrabold text-gray-100 flex items-center">
                      Kick #{index + 1}
                      {index === data.length - 1 && listening && (
                        <span className="ml-4 text-sm font-semibold text-green-400 bg-green-900/50 px-3 py-1 rounded-full animate-pulse-glow">
                          LATEST
                        </span>
                      )}
                    </h4>
                    <small className="text-gray-500 text-sm font-mono">
                      {item.timestamp_utc}
                    </small>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 text-gray-400">
                    <div className="bg-gray-800 p-4 rounded-lg flex justify-between items-center border border-gray-700">
                      <span className="font-semibold text-gray-300">
                        Force:
                      </span>
                      <span className="text-lg font-bold text-gray-300">
                        {item.force_of_kick_in_newton?.toFixed(2) || "N/A"} N
                      </span>
                    </div>
                    <div className="bg-gray-800 p-4 rounded-lg flex justify-between items-center border border-gray-700">
                      <span className="font-semibold text-gray-300">
                        Accuracy:
                      </span>
                      <span className={`text-sm font-bold px-3 py-1 rounded-full border ${getAccuracyBadge(item)}`}>
                        {(() => {
                          const v = getAccuracyValue(item);
                          const label = getAccuracyLabel(item);
                          if (v == null) return label === 'N/A' ? 'N/A' : `${label}`;
                          return `${v.toFixed?.(1) ?? v}% â€” ${label}`;
                        })()}
                      </span>
                    </div>
                    <div className="bg-gray-800 p-4 rounded-lg flex justify-between items-center border border-gray-700">
                      <span className="font-semibold text-gray-300">
                        Speed:
                      </span>
                      <span className="text-lg font-bold text-gray-300">
                        {item.speed_of_kick_in_meters_per_second?.toFixed(2) || "N/A"} m/s
                      </span>
                    </div>
                    <div className="bg-gray-800 p-4 rounded-lg flex justify-between items-center border border-gray-700">
                      <span className="font-semibold text-gray-300">
                        Kick Type:
                      </span>
                      <span className="text-lg font-bold text-gray-300 px-3 py-1 rounded-full bg-gray-900/30 border border-gray-700">
                        {getKickType(item)}
                      </span>
                    </div>
                    <div className="bg-gray-800 p-4 rounded-lg flex justify-between items-center border border-gray-700">
                      <span className="font-semibold text-gray-300">
                        Edge Pressure:
                      </span>
                      <span className="text-lg font-bold text-gray-300">
                        {item.pressure_at_edges_in_percentage?.toFixed(1) || "N/A"}%
                      </span>
                    </div>
                    <div className="bg-gray-800 p-4 rounded-lg flex justify-between items-center border border-gray-700">
                      <span className="font-semibold text-gray-300">
                        State:
                      </span>
                      <span className="text-sm font-bold text-green-400 bg-green-900/50 px-3 py-1 rounded-full">
                        {item.kick_detection_state || "N/A"}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {listening && data.length < 10 && (
              <div className="mt-8 text-center p-8 bg-gray-900 rounded-xl border-2 border-dashed border-gray-700 shadow-inner animate-pulse-glow">
                <div className="text-2xl font-bold text-gray-400 mb-2">
                  ðŸŽ¯ Ready for kick #{data.length + 1}...
                </div>
                <div className="text-md text-gray-600">
                  Perform your next kick - it will appear here instantly!
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add the Chatbot */}
      <TaekwondoChatbot 
        kickData={data} 
        isSessionComplete={isSessionComplete} 
        onSessionComplete={saveSessionToHistory}
      />
    </div>
  );
}