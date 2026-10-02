/* ================= Sound effects (Web Audio API — no audio files needed) ================= */
let audioCtx = null;
let muted = localStorage.getItem("rpsMuted") === "1";

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function tone(freq, dur, type = "sine", delay = 0, vol = 0.15) {
  if (muted) return;
  const c = getCtx();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, c.currentTime + delay);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + delay + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(c.currentTime + delay);
  osc.stop(c.currentTime + delay + dur);
}

const sfx = {
  click:       () => tone(600, 0.07, "square", 0, 0.07),
  think:       () => { tone(150, 0.45, "sine", 0, 0.05); tone(200, 0.45, "sine", 0.3, 0.05); },
  tie:         () => tone(300, 0.15, "triangle", 0, 0.1),
  userWin:     () => { tone(523, 0.12, "triangle", 0); tone(659, 0.12, "triangle", 0.1); tone(784, 0.22, "triangle", 0.2); },
  cpuWin:      () => { tone(392, 0.2, "sawtooth", 0, 0.07); tone(330, 0.2, "sawtooth", 0.22, 0.07); tone(262, 0.35, "sawtooth", 0.44, 0.07); },
  fanfare:     () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, "triangle", i * 0.13, 0.11)); tone(1319, 0.45, "triangle", 0.55, 0.11); },
  sadTrombone: () => { [330, 311, 294, 262].forEach((f, i) => tone(f, 0.32, "sawtooth", i * 0.32, 0.07)); },
};

/* ================= Game data ================= */
// The lookup table that decides who beats whom — works for 3 or 5 choices
const beats = {
  rock:     ["scissors", "lizard"],
  paper:    ["rock", "spock"],
  scissors: ["paper", "lizard"],
  lizard:   ["spock", "paper"],
  spock:    ["scissors", "rock"],
};

// What counters each choice (used by Hard difficulty and cheat mode)
const counterOf = { rock: "paper", paper: "scissors", scissors: "rock", lizard: "rock", spock: "paper" };
const emojiMap = { rock: "🪨", paper: "📄", scissors: "✂️", lizard: "🦎", spock: "🖖" };

// Returns 1 if a beats b, -1 if b beats a, 0 on a tie
function judge(a, b) {
  if (a === b) return 0;
  return beats[a].includes(b) ? 1 : -1;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const winsNeeded = 2; // best-of-3: first to 2

/* ================= State ================= */
const state = {
  userScore: 0,       // "You" in PvC, Player 1 in 2P
  cpuScore: 0,        // the computer in PvC, Player 2 in 2P
  round: 1,
  gameOver: false,
  consecutiveLosses: 0, // computer's losing streak (drives its anger)
  p1Choice: null,       // pass-and-play: remembers player 1's hidden pick
  userChoiceCounts: { rock: 0, paper: 0, scissors: 0, lizard: 0, spock: 0 },
};
let inputLocked = false;
let thinkToken = 0; // invalidates a pending "thinking" delay if the game resets

let cpuName = localStorage.getItem("rpsCpuName") || "";

// Career stats survive page reloads via localStorage
const career = Object.assign(
  { wins: 0, losses: 0, ties: 0, matchesWon: 0, matchesLost: 0, currentStreak: 0, bestStreak: 0 },
  JSON.parse(localStorage.getItem("rpsCareer") || "{}")
);
function saveCareer() { localStorage.setItem("rpsCareer", JSON.stringify(career)); }

/* ================= The computer's personality ================= */
const reactions = {
  idle: { face: "🤖", say: "Let's play! Choose your move." },
  idle2P: { face: "📣", say: "Pass the keyboard! Enter your moves in secret." },
  thinking: { face: "🤔", say: "Hmm, let me think..." },
  computerWins: [
    { face: "😈", say: "Ha! {name} strikes again!" },
    { face: "🤖", say: "Beep boop. Victory protocol complete." },
    { face: "😎", say: "Too easy. Try to keep up, human." },
    { face: "🥳", say: "{name} is UNSTOPPABLE!" },
  ],
  userWins: [
    { face: "😢", say: "That was pure luck. Rematch!" },
    { face: "😤", say: "Impossible! My calculations were perfect!" },
    { face: "🥺", say: "Okay, that one hurt my circuits." },
    { face: "😭", say: "Why would you do this to {name}?" },
  ],
  tie: [
    { face: "😐", say: "Great minds think alike, I suppose." },
    { face: "🙄", say: "A tie? How disappointingly symmetrical." },
    { face: "🤝", say: "We are evenly matched... for now." },
  ],
  onLosingStreak: [
    { face: "😡", say: "STOP. DOING. THAT." },
    { face: "🤬", say: "I am a supercomputer and I am LOSING?!" },
  ],
  matchWon:  { face: "🏆", say: "VICTORY! Bow before {name}!" },
  matchLost: { face: "💀", say: "System failure... you actually beat {name}." },
  refereeP1Wins: [{ face: "📣", say: "Player 1 takes the round!" }, { face: "🎉", say: "Point for Player 1!" }],
  refereeP2Wins: [{ face: "📣", say: "Player 2 takes the round!" }, { face: "🎉", say: "Point for Player 2!" }],
  refereeTie:    [{ face: "🤝", say: "Dead even!" }],
  refereeMatch:  [{ face: "🏁", say: "What a match!" }],
};

// Change the computer's face, mood animation, and speech
function express(mood, reaction) {
  avatarEl.textContent = reaction.face;
  speechEl.textContent = reaction.say.replaceAll("{name}", cpuName);
  avatarEl.className = "avatar";
  if (mood) avatarEl.classList.add(mood);
}

/* ================= DOM references ================= */
const setupEl = document.getElementById("setup");
const gameEl = document.getElementById("game");
const nameInput = document.getElementById("name-input");
const startBtn = document.getElementById("start-btn");
const resultEl = document.getElementById("result");
const emojiEl = document.getElementById("result-emojis");
const scoreEl = document.getElementById("score");
const roundEl = document.getElementById("round-counter");
const modeEl = document.getElementById("mode");
const difficultyEl = document.getElementById("difficulty");
const spockModeEl = document.getElementById("spock-mode");
const cheatModeEl = document.getElementById("cheat-mode");
const muteBtn = document.getElementById("mute");
const avatarEl = document.getElementById("avatar");
const speechEl = document.getElementById("speech");
const meterEl = document.getElementById("meter");
const meterBar = document.getElementById("meter-bar");
const buttons1 = document.getElementById("buttons1");
const buttons2 = document.getElementById("buttons2");
const passOverlay = document.getElementById("pass-overlay");
const passPrompt = document.getElementById("pass-prompt");
const passInput = document.getElementById("pass-input");
const historyEl = document.getElementById("history");
const careerNameEl = document.getElementById("career-name");
const careerStatsEl = document.getElementById("career-stats");
const flashEl = document.getElementById("flash");
const choiceButtons = document.querySelectorAll(".buttons button");

/* ================= Setup screen ================= */
nameInput.value = cpuName;
startBtn.addEventListener("click", startGame);
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") startGame(); });

function startGame() {
  cpuName = nameInput.value.trim() || "CPU-9000";
  localStorage.setItem("rpsCpuName", cpuName);
  careerNameEl.textContent = cpuName;
  document.title = `vs ${cpuName} — Rock Paper Scissors`;
  setupEl.classList.add("hidden");
  gameEl.classList.remove("hidden");
  renderCareer();
  resetGame();
}

/* ================= Effects helpers ================= */
function flash(color) {
  flashEl.className = "";
  void flashEl.offsetWidth; // restart the animation
  flashEl.classList.add("flash-" + color);
}

function shakePage() {
  document.body.classList.remove("shake");
  void document.body.offsetWidth;
  document.body.classList.add("shake");
}

function confetti() {
  const colors = ["#e0533d", "#4a90d9", "#f7c948", "#6bcf7f", "#b565d9"];
  for (let i = 0; i < 80; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = pick(colors);
    piece.style.animationDelay = Math.random() * 0.6 + "s";
    piece.style.animationDuration = 2 + Math.random() * 2 + "s";
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 5500);
  }
}

function showEmojis(a, b) {
  emojiEl.innerHTML = `
    <span class="hand shake">${emojiMap[a]}</span>
    <span class="hand shake">⚡</span>
    <span class="hand shake">${emojiMap[b]}</span>
  `;
}

// The fake probability bar that fills while the computer "thinks"
function showMeter(ms) {
  meterEl.classList.remove("hidden");
  meterBar.style.transition = "none";
  meterBar.style.width = "0%";
  void meterBar.offsetWidth;
  meterBar.style.transition = `width ${ms}ms linear`;
  meterBar.style.width = "100%";
}

function hideMeter() {
  meterEl.classList.add("hidden");
}

/* ================= Career stats ================= */
function recordRound(outcome) {
  if (modeEl.value === "twoPlayer") return; // career tracks you vs the computer only
  if (outcome === 0) career.ties++;
  else if (outcome === 1) {
    career.wins++;
    career.currentStreak++;
    career.bestStreak = Math.max(career.bestStreak, career.currentStreak);
  } else {
    career.losses++;
    career.currentStreak = 0;
  }
  saveCareer();
  renderCareer();
}

function renderCareer() {
  const c = career;
  let flavor;
  if (c.wins + c.losses + c.ties === 0) flavor = "No history yet. Go make some.";
  else if (c.wins >= c.losses * 2) flavor = `${cpuName} has not forgiven you.`;
  else if (c.losses >= c.wins * 2) flavor = `${cpuName} pities you.`;
  else flavor = "A respectable rivalry.";
  careerStatsEl.innerHTML =
    `Wins: ${c.wins} · Losses: ${c.losses} · Ties: ${c.ties}<br>` +
    `Matches won: ${c.matchesWon} · Matches lost: ${c.matchesLost} · Best streak: ${c.bestStreak}` +
    `<br><span class="career-flavor">${flavor}</span>`;
}

/* ================= History log ================= */
function addHistory(text) {
  const li = document.createElement("li");
  li.textContent = text;
  historyEl.prepend(li);
  while (historyEl.children.length > 15) historyEl.lastChild.remove();
}

/* ================= Scoreboard ================= */
function updateScoreboard() {
  scoreEl.textContent = modeEl.value === "twoPlayer"
    ? `Player 1: ${state.userScore} | Player 2: ${state.cpuScore}`
    : `You: ${state.userScore} | ${cpuName}: ${state.cpuScore}`;
}

/* ================= The computer's brain ================= */
function availableChoices() {
  return spockModeEl.checked
    ? ["rock", "paper", "scissors", "lizard", "spock"]
    : ["rock", "paper", "scissors"];
}

function computerPick(userChoice) {
  // Cheat mode: 25% chance it peeks and plays the thing that beats you
  if (cheatModeEl.checked && Math.random() < 0.25) {
    const choice = counterOf[userChoice];
    const other = pick(availableChoices().filter((c) => c !== choice));
    return { choice, cheated: true, fakeSaid: other };
  }
  // Hard mode: track your habits, then counter your most frequent pick 70% of the time
  if (difficultyEl.value === "hard") {
    const mostFrequent = Object.keys(state.userChoiceCounts)
      .sort((a, b) => state.userChoiceCounts[b] - state.userChoiceCounts[a])[0];
    if (state.userChoiceCounts[mostFrequent] > 0 && Math.random() < 0.7) {
      return { choice: counterOf[mostFrequent], cheated: false };
    }
  }
  return { choice: pick(availableChoices()), cheated: false };
}

/* ================= Player vs Computer ================= */
function makeChoice(userChoice) {
  if (state.gameOver || inputLocked) return;
  if (modeEl.value === "twoPlayer") { passInput.focus(); return; }

  sfx.click();
  inputLocked = true;
  choiceButtons.forEach((btn) => (btn.disabled = true));
  express("thinking", reactions.thinking);
  sfx.think();
  emojiEl.innerHTML = "";

  const thinkMs = 900 + Math.random() * 800;
  showMeter(thinkMs);
  const token = ++thinkToken;
  setTimeout(() => { if (token === thinkToken) reveal(userChoice); }, thinkMs);
}

function reveal(userChoice) {
  hideMeter();
  state.userChoiceCounts[userChoice]++; // feeds Hard mode's habit tracking

  const { choice: cpuChoice, cheated, fakeSaid } = computerPick(userChoice);
  showEmojis(userChoice, cpuChoice);

  const outcome = judge(userChoice, cpuChoice); // 1 = you win, -1 = computer wins, 0 = tie
  let message, reaction, mood;

  if (outcome === 0) {
    reaction = pick(reactions.tie);
    mood = null;
    message = `It's a tie! Both chose ${userChoice}.`;
    sfx.tie();
  } else if (outcome === 1) {
    state.userScore++;
    state.consecutiveLosses++;
    reaction = state.consecutiveLosses >= 3 ? pick(reactions.onLosingStreak) : pick(reactions.userWins);
    mood = "sad";
    message = `You win round ${state.round}! ${userChoice} beats ${cpuChoice}.`;
    sfx.userWin();
    shakePage();
  } else {
    state.cpuScore++;
    state.consecutiveLosses = 0;
    reaction = pick(reactions.computerWins);
    mood = "happy";
    message = `You lose round ${state.round}! ${cpuChoice} beats ${userChoice}.`;
    sfx.cpuWin();
    shakePage();
    flash("red");
  }

  // A cheater always gloats the same way
  if (cheated) {
    reaction = { face: "😇", say: `Oops... did I say ${fakeSaid}? I meant ${cpuChoice}! My bad.` };
    mood = "happy";
  }

  recordRound(outcome);
  express(mood, reaction);
  resultEl.textContent = message;
  updateScoreboard();
  addHistory(
    outcome === 0
      ? `R${state.round} · You: ${emojiMap[userChoice]} vs ${cpuName}: ${emojiMap[cpuChoice]} — Tie 🤝`
      : outcome === 1
        ? `R${state.round} · You: ${emojiMap[userChoice]} vs ${cpuName}: ${emojiMap[cpuChoice]} — You won 🎉`
        : `R${state.round} · You: ${emojiMap[userChoice]} vs ${cpuName}: ${emojiMap[cpuChoice]} — ${cpuName} won 😈`
  );

  if (modeEl.value === "bestOf3") checkBestOf3();

  inputLocked = state.gameOver;
  choiceButtons.forEach((btn) => (btn.disabled = state.gameOver));

  if (!state.gameOver) {
    state.round++;
    roundEl.textContent = `Round: ${state.round}`;
  }
}

/* ================= Two-player (pass-and-play) ================= */
function parseChoice(text) {
  const map = {
    r: "rock", rock: "rock",
    p: "paper", paper: "paper",
    s: "scissors", scissors: "scissors",
    l: "lizard", lizard: "lizard",
    k: "spock", spock: "spock",
  };
  return map[text.trim().toLowerCase()] || null;
}

passInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (state.gameOver) return;

  const choice = parseChoice(passInput.value);
  passInput.value = "";
  if (!choice) { passPrompt.textContent = "Invalid! Type r, p, or s and press Enter."; return; }
  if (!spockModeEl.checked && (choice === "lizard" || choice === "spock")) {
    passPrompt.textContent = "Rock, paper, or scissors only!";
    return;
  }

  sfx.click();
  if (state.p1Choice === null) {
    state.p1Choice = choice;
    passPrompt.textContent = "Player 2 — type your move and press Enter";
  } else {
    revealTwoPlayer(state.p1Choice, choice);
    state.p1Choice = null;
  }
  passInput.focus();
});

function revealTwoPlayer(p1, p2) {
  showEmojis(p1, p2);
  const outcome = judge(p1, p2);
  let message, reaction, mood;

  if (outcome === 0) {
    reaction = pick(reactions.refereeTie);
    mood = null;
    message = `Tie! Both chose ${p1}.`;
    sfx.tie();
  } else if (outcome === 1) {
    state.userScore++;
    reaction = pick(reactions.refereeP1Wins);
    mood = "happy";
    message = `Player 1 wins round ${state.round}! ${p1} beats ${p2}.`;
    sfx.userWin();
    shakePage();
  } else {
    state.cpuScore++;
    reaction = pick(reactions.refereeP2Wins);
    mood = "sad";
    message = `Player 2 wins round ${state.round}! ${p2} beats ${p1}.`;
    sfx.cpuWin();
    shakePage();
  }

  express(mood, reaction);
  resultEl.textContent = message;
  updateScoreboard();
  addHistory(
    outcome === 0
      ? `R${state.round} · P1: ${emojiMap[p1]} vs P2: ${emojiMap[p2]} — Tie 🤝`
      : outcome === 1
        ? `R${state.round} · P1: ${emojiMap[p1]} vs P2: ${emojiMap[p2]} — P1 won 🎉`
        : `R${state.round} · P1: ${emojiMap[p1]} vs P2: ${emojiMap[p2]} — P2 won 🎉`
  );

  if (modeEl.value === "bestOf3") checkBestOf3();

  if (!state.gameOver) {
    state.round++;
    roundEl.textContent = `Round: ${state.round}`;
    passPrompt.textContent = "Player 1 — type your move and press Enter";
  } else {
    passPrompt.textContent = "Game over! Press Play Again.";
  }
}

/* ================= Best-of-3 match logic ================= */
function checkBestOf3() {
  const names = modeEl.value === "twoPlayer"
    ? { a: "Player 1", b: "Player 2" }
    : { a: "You", b: cpuName };

  // Match point drama when someone is one win away
  if (!state.gameOver && (state.userScore === winsNeeded - 1 || state.cpuScore === winsNeeded - 1)) {
    const leader = state.userScore > state.cpuScore ? "a" : "b";
    express(null, { face: leader === "a" ? "😰" : "😏", say: `Match point for ${names[leader]}!` });
  }

  if (state.userScore >= winsNeeded || state.cpuScore >= winsNeeded) {
    state.gameOver = true;
    const aWins = state.userScore > state.cpuScore;

    if (modeEl.value === "twoPlayer") {
      resultEl.textContent = `${names[aWins ? "a" : "b"]} wins the match! 🏆`;
      express(aWins ? "happy" : "sad", pick(reactions.refereeMatch));
      sfx.fanfare();
      if (aWins) confetti();
    } else if (aWins) {
      resultEl.textContent = "You win the match! 🏆";
      express("sad", reactions.matchLost);
      career.matchesWon++;
      saveCareer();
      renderCareer();
      flash("gold");
      confetti();
      sfx.fanfare();
    } else {
      resultEl.textContent = `${cpuName} wins the match! 🤖`;
      express("happy", reactions.matchWon);
      career.matchesLost++;
      saveCareer();
      renderCareer();
      flash("red");
      sfx.sadTrombone();
    }
  }
}

/* ================= Wiring ================= */
choiceButtons.forEach((button) => {
  button.addEventListener("click", () => makeChoice(button.id));
});

// Keyboard controls: R / P / S (plus L / K in Lizard & Spock mode)
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return; // don't hijack typing
  if (!gameEl || gameEl.classList.contains("hidden")) return;
  const map = { r: "rock", p: "paper", s: "scissors", l: "lizard", k: "spock" };
  const choice = map[e.key.toLowerCase()];
  if (!choice) return;
  if ((choice === "lizard" || choice === "spock") && !spockModeEl.checked) return;
  if (modeEl.value === "twoPlayer") { passInput.focus(); return; }
  makeChoice(choice);
});

muteBtn.textContent = muted ? "🔇" : "🔊";
muteBtn.addEventListener("click", () => {
  muted = !muted;
  localStorage.setItem("rpsMuted", muted ? "1" : "0");
  muteBtn.textContent = muted ? "🔇" : "🔊";
});

modeEl.addEventListener("change", resetGame);
difficultyEl.addEventListener("change", resetGame);
spockModeEl.addEventListener("change", () => {
  buttons2.classList.toggle("hidden", !spockModeEl.checked);
  passInput.placeholder = spockModeEl.checked ? "r / p / s / l / k" : "r / p / s";
  resetGame();
});
document.getElementById("reset").addEventListener("click", resetGame);

// Show/hide UI pieces depending on the selected mode
function updateModeUI() {
  const twoP = modeEl.value === "twoPlayer";
  buttons1.classList.toggle("hidden", twoP);
  buttons2.classList.toggle("hidden", twoP || !spockModeEl.checked);
  passOverlay.classList.toggle("hidden", !twoP);
  if (twoP) {
    passPrompt.textContent = state.gameOver
      ? "Game over! Press Play Again."
      : "Player 1 — type your move and press Enter";
    passInput.value = "";
    passInput.focus();
  }
}

function resetGame() {
  state.userScore = 0;
  state.cpuScore = 0;
  state.round = 1;
  state.gameOver = false;
  state.consecutiveLosses = 0;
  state.p1Choice = null;
  state.userChoiceCounts = { rock: 0, paper: 0, scissors: 0, lizard: 0, spock: 0 };
  inputLocked = false;
  thinkToken++; // cancels any pending "thinking" reveal

  resultEl.textContent = modeEl.value === "twoPlayer"
    ? "Enter your moves in secret!"
    : "Make your move!";
  emojiEl.innerHTML = "";
  historyEl.innerHTML = "";
  roundEl.textContent = "Round: 1";
  flashEl.className = "";
  hideMeter();
  updateScoreboard();
  updateModeUI();
  choiceButtons.forEach((btn) => (btn.disabled = false));
  express(null, modeEl.value === "twoPlayer" ? reactions.idle2P : reactions.idle);
}
