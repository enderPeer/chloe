/* CHLOE — data/config.js */
window.CHLOE=window.CHLOE||{};CHLOE.data=CHLOE.data||{};

CHLOE.data.config = {
  version: 1,
  // Cloud-save API base URL. Empty string = local-only mode (all cloud calls silently no-op).
  apiUrl: '',
  // Gameplay tuning
  levelCap: 50,
  fleeChance: 0.7,
  defeatShardLossPct: 30,
  typewriterMs: 16,
  debug: false
};
