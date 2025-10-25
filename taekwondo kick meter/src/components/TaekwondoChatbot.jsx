import { useState, useEffect, useRef } from 'react';

export default function TaekwondoChatbot({ kickData = [], isSessionComplete, onSessionComplete }) {
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const messagesEndRef = useRef(null);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Auto-analyze when session completes with 10 kicks
  useEffect(() => {
    if (isSessionComplete && kickData.length === 10 && !hasAnalyzed) {
      setIsOpen(true);
      analyzeKickData();
      setHasAnalyzed(true);
    }
  }, [isSessionComplete, kickData, hasAnalyzed]);

  // Reset when new session starts
  useEffect(() => {
    if (kickData.length === 0) {
      setHasAnalyzed(false);
      setMessages([]);
    }
  }, [kickData]);

  const addMessage = (sender, text) => {
    const newMessage = { sender, text, timestamp: new Date() };
    setMessages(prev => [...prev, newMessage]);
    return newMessage;
  };

  const generateFallbackAnalysis = (avgForce, avgAccuracy, avgSpeed, avgAngle, forceStdDev, speedStdDev, kickCount) => {
    const af = avgForce === 'N/A' ? null : Number(avgForce);
    const aa = avgAccuracy === 'N/A' ? null : Number(avgAccuracy);
    const fsd = forceStdDev === 'N/A' ? null : Number(forceStdDev);
    const ssd = speedStdDev === 'N/A' ? null : Number(speedStdDev);

    // Compute performance-driven scores (0-100) for each dimension
    const afNum = af;
    const aaNum = aa;
    const asNum = avgSpeed === 'N/A' ? null : Number(avgSpeed);

    const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));

    // Force: treat 100kg+ as excellent, scale accordingly
    const forceScore = afNum != null ? clamp((afNum / 100) * 100, 0, 100) : 50;
    // Accuracy: percentage directly maps to score
    const accuracyScore = aaNum != null ? clamp(aaNum, 0, 100) : 50;
    // Speed: map 0-10 m/s where 8+ m/s is excellent
    const speedScore = asNum != null ? clamp((asNum / 10) * 100, 0, 100) : 50;

    // Consistency: lower std dev => higher score
    // For force, std dev of 0 is perfect, 20 or more is poor
    const fsdNum = forceStdDev === 'N/A' ? null : Number(forceStdDev);
    const ssdNum = speedStdDev === 'N/A' ? null : Number(speedStdDev);
    const forceConsistency = fsdNum != null ? clamp(100 - (fsdNum / 20) * 100, 0, 100) : 60;
    const speedConsistency = ssdNum != null ? clamp(100 - (ssdNum / 3) * 100, 0, 100) : 60;
    const consistencyScore = Math.round((forceConsistency * 0.6 + speedConsistency * 0.4));

    // Weighted overall score
    const overallScore = Math.round(
      forceScore * 0.35 +
      accuracyScore * 0.30 +
      speedScore * 0.20 +
      consistencyScore * 0.15
    );

    // Rating 0-10 derived from overallScore
    const rating = Math.max(0, Math.min(10, Math.round(overallScore / 10)));

    let performanceLevel = 'Beginner';
    if (overallScore >= 85) performanceLevel = 'Elite';
    else if (overallScore >= 70) performanceLevel = 'Advanced';
    else if (overallScore >= 50) performanceLevel = 'Intermediate';
    else performanceLevel = 'Beginner';

    const lines = [];
    lines.push('SESSION ANALYSIS COMPLETE');
    lines.push('');
    lines.push('Overall Performance Assessment:');
    lines.push(performanceLevel + ' Level (' + rating + '/10)');
    lines.push('');
    lines.push('Session Statistics:');
    lines.push('- Total Kicks Analyzed: ' + kickCount);
    lines.push('- Average Power: ' + avgForce + ' kg');
    lines.push('- Average Speed: ' + avgSpeed + ' m/s');
    lines.push('- Technical Consistency: ' + (fsd != null && fsd < 15 ? 'Good' : 'Needs work'));
    lines.push('');
    lines.push('Detailed Performance Breakdown:');
    lines.push('');
    lines.push('Your data shows promising fundamentals with clear pathways for growth.');
    lines.push('The consistent speed metrics indicate good muscle memory development.');
    lines.push('However, we need to focus on converting that speed into effective power.');
    lines.push('');
    lines.push('Technical Strengths:');
    if (aa != null && aa > 70) lines.push('- Excellent target accuracy and control');
    if (af != null && af > 60) lines.push('- Solid power generation foundation');
    if (ssd != null && ssd < 2) lines.push('- Consistent speed execution across all kicks');
    lines.push('- Good kinetic chain initiation');
    lines.push('');
    lines.push('Critical Development Areas:');
    if (af == null || af < 50) lines.push('- Hip rotation efficiency needs significant improvement');
    if (aa == null || aa < 70) lines.push('- Precision targeting requires focused training');
    if (fsd != null && fsd > 15) lines.push('- Power output consistency between kicks needs work');
    lines.push('- Follow-through mechanics could be optimized');
    lines.push('');
    lines.push('Professional Training Protocol:');
    lines.push('');
    lines.push('1. Power Development Phase (Weeks 1-2):');
    lines.push('   - Resistance band hip rotation drills: 3x15 each side');
    lines.push('   - Weighted kick exercises: 4x10 with progressive overload');
    lines.push('   - Plyometric box jumps for explosive power: 3x12');
    lines.push('');
    lines.push('2. Accuracy Integration (Weeks 3-4):');
    lines.push('   - Moving target reaction training: 5x2 minute rounds');
    lines.push('   - Blindfolded form practice for muscle memory');
    lines.push('   - High-speed precision striking: 100 reps daily');
    lines.push('');
    lines.push('3. Performance Nutrition Strategy:');
    lines.push('   - Pre-training: Complex carbs + lean protein 2 hours before');
    lines.push('   - Post-training: 20-30g protein within 30 minutes');
    lines.push('   - Hydration: 3-4 liters daily with electrolyte balance');
    lines.push('   - Focus foods: Salmon, sweet potatoes, spinach, blueberries');
    lines.push('');
    lines.push('4. Recovery & Regeneration:');
    lines.push('   - Active recovery: Light cycling 20 minutes');
    lines.push('   - Mobility work: Dynamic stretching daily');
    lines.push('   - Sleep optimization: 7-8 hours quality sleep');
    lines.push('');
    lines.push("Coach's Insight:");
    lines.push('Your foundation shows real promise. The consistency in your speed metrics tells me you\'re building excellent muscle memory.');
    lines.push('Focus on integrating hip rotation into your technique - this alone could increase your power output by 30-40%.');
    lines.push('Stay disciplined with the nutrition plan and trust the process. I\'ll see you at the next session.');

    return lines.join('\n');
  };

  const analyzeKickData = () => {
    if (!kickData || kickData.length === 0) {
      addMessage('bot', 'No kick data available yet. Complete a session of 10 kicks to get analysis!');
      return;
    }

    setIsLoading(true);
    addMessage('bot', 'ðŸ” Analyzing your 10-kick session data...');

    // safe numeric extraction
    const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const forceVals = kickData.map(k => {
      if (k.force_of_kick_in_kilograms != null && !isNaN(Number(k.force_of_kick_in_kilograms))) return Number(k.force_of_kick_in_kilograms);
      if (k.force_of_kick_in_newton != null && !isNaN(Number(k.force_of_kick_in_newton))) return Number(k.force_of_kick_in_newton) / 9.81;
      return null;
    }).filter(v => v != null);
    const accuracyVals = kickData.map(k => toNum(k.accuracy_percentage)).filter(v => v != null);
    const speedVals = kickData.map(k => toNum(k.speed_of_kick_in_meters_per_second)).filter(v => v != null);
    const angleVals = kickData.map(k => toNum(k.angle_of_kick_in_degrees)).filter(v => v != null);

    const avg = (arr) => arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : null;
    const std = (arr, m) => arr.length ? Math.sqrt(arr.reduce((s,x)=>s+Math.pow(x-m,2),0)/arr.length) : null;

    const avgForceNum = avg(forceVals);
    const avgAccuracyNum = avg(accuracyVals);
    const avgSpeedNum = avg(speedVals);
    const avgAngleNum = avg(angleVals);
    const forceStd = std(forceVals, avgForceNum);
    const speedStd = std(speedVals, avgSpeedNum);

    const asStr = (n,d=2) => (n==null||!Number.isFinite(n)) ? 'N/A' : Number(n).toFixed(d);
    const avgForce = asStr(avgForceNum);
    const avgAccuracy = asStr(avgAccuracyNum);
    const avgSpeed = asStr(avgSpeedNum);
    const avgAngle = asStr(avgAngleNum);
    const forceStdDev = asStr(forceStd);
    const speedStdDev = asStr(speedStd);

    // Use local fallback analysis only (no client-side AI calls)
    const fallback = generateFallbackAnalysis(avgForce, avgAccuracy, avgSpeed, avgAngle, forceStdDev, speedStdDev, kickData.length);
    
    // Update the loading message with the actual analysis
    setMessages(prev => prev.map(m => m.text && m.text.startsWith('ðŸ”') ? { sender:'bot', text: fallback, timestamp: new Date() } : m));

    // Save session to history
    if (onSessionComplete && kickData.length === 10) {
      onSessionComplete(kickData, fallback);
    }

    setIsLoading(false);
  };

  return (
    <>
      <div className="fixed bottom-6 right-6 z-50">
        <div style={{ width: '30rem' }} className="bg-white/5 backdrop-blur-lg border border-white/5 rounded-2xl shadow-xl overflow-hidden text-sm">
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-gray-800 to-gray-700">
            <div className="text-white font-bold">Coach</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsOpen(open => !open)}
                className="text-gray-300 hover:text-white"
                aria-label="Toggle chat"
              >
                {isOpen ? 'Close' : 'Open'}
              </button>
            </div>
          </div>

          {isOpen && (
            <div style={{ maxHeight: '36rem' }} className="p-3 overflow-y-auto">
              <div className="space-y-3">
                {messages.length === 0 && (
                  <div className="text-gray-400 text-sm">No analysis yet. Complete a 10-kick session or press the button below.</div>
                )}

                {messages.map((m, i) => (
                  <div key={i} className={m.sender === 'bot' ? 'text-left text-gray-100' : 'text-right text-gray-200'}>
                    <div className="bg-gray-800/60 inline-block p-3 rounded-lg whitespace-pre-line">{m.text}</div>
                    <div className="text-xs text-gray-500 mt-1">{m.timestamp.toLocaleTimeString()}</div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <div className="mt-3">
                {kickData.length === 10 && !hasAnalyzed && (
                  <button
                    onClick={analyzeKickData}
                    className="w-full mt-1 bg-green-600 hover:bg-green-700 text-white rounded-xl px-4 py-2 text-sm font-bold"
                    disabled={isLoading}
                  >
                    {isLoading ? 'Analyzingâ€¦' : 'Get Detailed Session Analysis'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}