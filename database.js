// JSON 파일로 데이터 저장/로드
const fs = require('fs');
const path = require('path');

// Railway Volume 사용 시: Variables에 DATA_DIR=/data 설정 (Volume 마운트 경로와 맞출 것)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
if (process.env.DATA_DIR) {
  console.log('[DB] 데이터 저장 경로(Volume):', DATA_FILE);
}

// 데이터 로드
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('데이터 로드 오류:', error);
  }
  return {
    users: {},
    characters: {},
    weapons: {},
    inventories: {},
    skills: {}
  };
}

// 데이터 저장
function saveData() {
  try {
    if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const data = {
      users,
      characters,
      weapons,
      inventories,
      skills
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('데이터 저장 오류:', error);
  }
}

// 초기 데이터 로드
let { users, characters, weapons, inventories, skills } = loadData();

function getOrCreateUser(id) {
  if (!users[id]) {
    users[id] = { 
      dust: 0, 
      last_attendance_date: null, 
      last_exploration_date: null, 
      exploration_count: 0, 
      last_battle_date: null, 
      battle_count: 0, 
      last_heal_date: null,
      in_dungeon: false,
      dungeon_floor: 0,
      dungeon_mana: 0
    };
    saveData();
  }
  return users[id];
}

function getOrCreateCharacter(id) {
  if (!characters[id]) {
    characters[id] = { 
      name: '모험가', 
      level: 0, 
      exp: 0, 
      current_hp: 50, 
      max_hp: 50, 
      attack: 10, 
      defense: 10, 
      magic: 20,
      mana: 0,
      max_mana: 50
    };
    saveData();
  }
  return characters[id];
}

function getInventory(id) {
  if (!inventories[id]) {
    inventories[id] = [];
    saveData();
  }
  return inventories[id];
}

function addDust(id, amount) {
  getOrCreateUser(id).dust += amount;
  saveData();
}

function subtractDust(id, amount) {
  getOrCreateUser(id).dust = Math.max(0, getOrCreateUser(id).dust - amount);
  saveData();
}

function setAttendance(id, date) {
  getOrCreateUser(id).last_attendance_date = date;
  saveData();
}
function resetExplorationCount(id) {
  const user = getOrCreateUser(id);
  const today = new Date().toISOString().split('T')[0];
  user.exploration_count = 0;
  user.last_exploration_date = today;
  saveData();
}

function incrementExploration(id) {
  const user = getOrCreateUser(id);
  const today = new Date().toISOString().split('T')[0];
  if (user.last_exploration_date !== today) {
    resetExplorationCount(id);
  }
  user.exploration_count = (user.exploration_count || 0) + 1;
  user.last_exploration_date = today;
  saveData();
}

function addItem(id, name, type = 'item', qty = 1) {
  const inv = getInventory(id);
  const it = inv.find(i => i.item_name === name);
  if (it) {
    it.quantity += qty;
  } else {
    inv.push({ item_name: name, item_type: type, quantity: qty });
  }
  saveData();
}

function removeItem(id, name, qty = 1) {
  const inv = getInventory(id);
  const idx = inv.findIndex(i => i.item_name === name);
  if (idx === -1) return false;
  if (inv[idx].quantity < qty) return false;
  inv[idx].quantity -= qty;
  if (inv[idx].quantity === 0) inv.splice(idx, 1);
  saveData();
  return true;
}

function getWeapon(id) { return weapons[id] || null; }

function equipWeapon(id, type) {
  // 기존 무기 정보가 있으면 강화 레벨 보존
  if (!weapons[id]) {
    weapons[id] = { 
      weapon_type: type, 
      enhancement: 0,
      enhancements: { '검': 0, '방패': 0, '지팡이': 0 }
    };
  } else {
    // enhancements 객체가 없으면 초기화
    if (!weapons[id].enhancements) {
      weapons[id].enhancements = { '검': 0, '방패': 0, '지팡이': 0 };
      // 기존 강화 레벨을 현재 무기 타입에 저장
      if (weapons[id].weapon_type) {
        weapons[id].enhancements[weapons[id].weapon_type] = weapons[id].enhancement || 0;
      }
    }
    // 무기 타입 변경 시 해당 타입의 강화 레벨로 복원
    weapons[id].weapon_type = type;
    weapons[id].enhancement = weapons[id].enhancements[type] || 0;
  }
  saveData();
}

function enhanceWeapon(id, success, destroyed) {
  if (!weapons[id]) return false;
  
  // enhancements 객체 초기화 (없는 경우)
  if (!weapons[id].enhancements) {
    weapons[id].enhancements = { '검': 0, '방패': 0, '지팡이': 0 };
    if (weapons[id].weapon_type) {
      weapons[id].enhancements[weapons[id].weapon_type] = weapons[id].enhancement || 0;
    }
  }
  
  const weaponType = weapons[id].weapon_type;
  
  if (destroyed) {
    // 무기 파괴 시 해당 타입의 강화 레벨만 초기화
    weapons[id].enhancements[weaponType] = 0;
    weapons[id].enhancement = 0;
    saveData();
    return { success: false, destroyed: true };
  }
  if (success) {
    // 강화 성공 시 해당 타입의 강화 레벨 증가
    const newLevel = Math.min(20, (weapons[id].enhancements[weaponType] || 0) + 1);
    weapons[id].enhancements[weaponType] = newLevel;
    weapons[id].enhancement = newLevel;
    saveData();
    return { success: true, destroyed: false, newLevel: newLevel };
  }
  return { success: false, destroyed: false };
}

function getOrCreateSkill(id) {
  if (!skills[id]) {
    skills[id] = { skill_name: null, skill_type: null, skill_level: 0 };
    saveData();
  }
  return skills[id];
}

function setSkill(id, skillType, skillName) {
  if (!skills[id]) {
    skills[id] = { skill_name: skillName, skill_type: skillType, skill_level: 0 };
  } else {
    skills[id].skill_type = skillType;
    skills[id].skill_name = skillName;
  }
  saveData();
}

function enhanceSkill(id, success) {
  if (!skills[id]) getOrCreateSkill(id);
  if (success) {
    skills[id].skill_level += 1;
    saveData();
  }
}

function addExp(id, amount) {
  const char = getOrCreateCharacter(id);
  const oldLevel = char.level;
  let newExp = char.exp + amount;
  let newLevel = char.level;
  
  // 레벨업 체크 (최대 레벨 20)
  while (newLevel < 20) {
    const requiredExp = (newLevel + 1) * 5;
    if (newExp >= requiredExp) {
      newExp -= requiredExp;
      newLevel++;
    } else {
      break;
    }
  }
  
  // 스탯 계산
  const maxHp = 50 + (newLevel * 10);
  const attack = 10 + (newLevel * 2);
  const defense = 10 + (newLevel * 2);
  const magic = 20 + (newLevel * 5);
  
  // 현재 HP도 레벨업에 따라 증가
  const currentHp = char.current_hp + ((newLevel - char.level) * 10);
  
  char.level = newLevel;
  char.exp = newExp;
  char.max_hp = maxHp;
  char.current_hp = Math.min(currentHp, maxHp);
  char.attack = attack;
  char.defense = defense;
  char.magic = magic;
  
  saveData();
  return { leveledUp: newLevel > oldLevel, newLevel, oldLevel };
}

function updateCharacterName(id, name) {
  getOrCreateCharacter(id).name = name;
  saveData();
}

// 배틀 관련 함수
function resetBattleCount(id) {
  const user = getOrCreateUser(id);
  const today = new Date().toISOString().split('T')[0];
  user.battle_count = 0;
  user.last_battle_date = today;
  saveData();
}

function incrementBattle(id) {
  const user = getOrCreateUser(id);
  const today = new Date().toISOString().split('T')[0];
  if (user.last_battle_date !== today) {
    resetBattleCount(id);
  }
  user.battle_count = (user.battle_count || 0) + 1;
  user.last_battle_date = today;
  saveData();
}

function getBattleCount(id) {
  const user = getOrCreateUser(id);
  const today = new Date().toISOString().split('T')[0];
  if (user.last_battle_date !== today) {
    resetBattleCount(id);
  }
  return user.battle_count || 0;
}

// 캐릭터 이름으로 ID 찾기
function findUserByName(name) {
  for (const [id, char] of Object.entries(characters)) {
    if (char.name === name) {
      return id;
    }
  }
  return null;
}

// 배틀용 랜덤 상대 캐릭터 ID (자기 자신 제외)
function getRandomCharacterId(excludeId) {
  const ids = Object.keys(characters).filter(id => id !== excludeId);
  if (ids.length === 0) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}

// 체력 감소
function decreaseHp(id, amount) {
  const char = getOrCreateCharacter(id);
  char.current_hp = Math.max(0, char.current_hp - amount);
  saveData();
  return char.current_hp;
}

// 체력 회복
function healHp(id, amount) {
  const char = getOrCreateCharacter(id);
  char.current_hp = Math.min(char.max_hp, char.current_hp + amount);
  saveData();
  return char.current_hp;
}

// 체력을 최대치로 회복
function fullHeal(id) {
  const char = getOrCreateCharacter(id);
  char.current_hp = char.max_hp;
  saveData();
}

// 마나 회복 (던전 내 마나, 최대치까지)
function healMana(id, amount) {
  const char = getOrCreateCharacter(id);
  const maxMana = char.max_mana || 50;
  char.mana = Math.min(maxMana, (char.mana || 0) + amount);
  saveData();
  return char.mana;
}

// 자정 체력 회복 체크
function checkDailyHeal(id) {
  // users 객체에 직접 접근하여 무한 재귀 방지
  if (!users[id]) {
    users[id] = { dust: 0, last_attendance_date: null, last_exploration_date: null, exploration_count: 0, last_battle_date: null, battle_count: 0, last_heal_date: null };
  }
  
  const user = users[id];
  const today = new Date().toISOString().split('T')[0];
  
  // 마지막 체력 회복 날짜가 오늘이 아니면 회복
  if (user.last_heal_date !== today) {
    // characters 객체에 직접 접근
    if (!characters[id]) {
      characters[id] = { name: '모험가', level: 0, exp: 0, current_hp: 50, max_hp: 50, attack: 10, defense: 10, magic: 20 };
    }
    characters[id].current_hp = characters[id].max_hp;
    user.last_heal_date = today;
    saveData();
    return true;
  }
  return false;
}

// 던전 관련 함수
function enterDungeon(id) {
  const user = getOrCreateUser(id);
  const char = getOrCreateCharacter(id);
  
  if (user.in_dungeon) {
    return { success: false, message: '이미 던전에 있습니다.' };
  }
  
  // 마나 초기화 (최대 마나로)
  char.mana = char.max_mana || 50;
  user.in_dungeon = true;
  
  // 이전 층이 있으면 그 층부터, 없으면 1층부터
  if (user.dungeon_floor === 0) {
    user.dungeon_floor = 1;
  }
  
  saveData();
  return { success: true, floor: user.dungeon_floor, mana: char.mana };
}

function exitDungeon(id) {
  const user = getOrCreateUser(id);
  if (!user.in_dungeon) {
    return { success: false, message: '던전에 있지 않습니다.' };
  }
  
  user.in_dungeon = false;
  // 층은 유지 (재진입 시 이전 층부터)
  saveData();
  return { success: true, floor: user.dungeon_floor };
}

function resetDungeon(id) {
  const user = getOrCreateUser(id);
  user.in_dungeon = false;
  user.dungeon_floor = 0;
  saveData();
}

function useDungeonMana(id, amount) {
  const char = getOrCreateCharacter(id);
  if (char.mana < amount) {
    return false;
  }
  char.mana -= amount;
  saveData();
  return true;
}

function getDungeonMana(id) {
  const char = getOrCreateCharacter(id);
  return char.mana || 0;
}

function advanceDungeonFloor(id) {
  const user = getOrCreateUser(id);
  user.dungeon_floor = (user.dungeon_floor || 0) + 1;
  saveData();
  return user.dungeon_floor;
}

function getDungeonFloor(id) {
  const user = getOrCreateUser(id);
  return user.dungeon_floor || 0;
}

function isInDungeon(id) {
  const user = getOrCreateUser(id);
  return user.in_dungeon || false;
}

module.exports = {
  getOrCreateUser, getOrCreateCharacter, addDust, subtractDust, setAttendance,
  resetExplorationCount, incrementExploration, addItem, removeItem, getInventory,
  getWeapon, equipWeapon, enhanceWeapon, getOrCreateSkill, setSkill, enhanceSkill,
  addExp, updateCharacterName, resetBattleCount, incrementBattle, getBattleCount,
  findUserByName, getRandomCharacterId, decreaseHp, healHp, fullHeal, healMana, checkDailyHeal,
  enterDungeon, exitDungeon, resetDungeon, useDungeonMana, getDungeonMana,
  advanceDungeonFloor, getDungeonFloor, isInDungeon
};
