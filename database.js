// JSON 파일로 데이터 저장/로드
const fs = require('fs');
const path = require('path');

// Railway Volume 사용 시: Variables에 DATA_DIR=/data 설정 (Volume 마운트 경로와 맞출 것)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// 시작 시 항상 저장 경로 출력 (Railway 로그에서 확인 가능)
console.log('[DB] 데이터 저장 경로:', DATA_FILE, process.env.DATA_DIR ? '(Volume 사용)' : '(⚠️ DATA_DIR 미설정 - 재배포 시 초기화됨)');

// DATA_DIR이 설정된 경우 볼륨 쓰기 가능 여부 검증
if (process.env.DATA_DIR) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log('[DB] Volume 디렉터리 생성:', DATA_DIR);
    }
    const testFile = path.join(DATA_DIR, '.volume_check');
    fs.writeFileSync(testFile, Date.now().toString(), 'utf8');
    fs.unlinkSync(testFile);
    console.log('[DB] Volume 쓰기 검증 완료:', DATA_DIR);
  } catch (err) {
    console.error('[DB] ⚠️ Volume 쓰기 실패 - 데이터가 저장되지 않을 수 있음:', err.message);
  }
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
    inventories: {}
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
      inventories
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('[DB] 데이터 저장 오류 - Volume 경로 확인 필요:', DATA_FILE, error.message);
  }
}

// 초기 데이터 로드
let { users, characters, weapons, inventories } = loadData();
const userCount = Object.keys(users).length;
const charCount = Object.keys(characters).length;
console.log('[DB] 로드 완료:', userCount, '유저,', charCount, '캐릭터 (파일:', DATA_FILE + ')');

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
      dungeon_floor: 0
    };
    saveData();
  }
  // 이전 데이터 오류로 음수 먼지가 저장된 경우 보정
  if (users[id].dust != null && users[id].dust < 0) {
    users[id].dust = 0;
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
      defense: 10
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
  const user = getOrCreateUser(id);
  const current = Math.max(0, user.dust || 0);
  const deduct = Math.min(amount, current); // 절대 보유량 초과 차감 방지
  user.dust = current - deduct;
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
  if (!weapons[id]) {
    weapons[id] = { weapon_type: type, enhancement: 0, enhancements: { '가시': 0, '껍질': 0 } };
  } else {
    if (!weapons[id].enhancements) {
      weapons[id].enhancements = { '가시': 0, '껍질': 0 };
      if (weapons[id].weapon_type) {
        weapons[id].enhancements[weapons[id].weapon_type] = weapons[id].enhancement || 0;
      }
    }
    weapons[id].weapon_type = type;
    weapons[id].enhancement = weapons[id].enhancements[type] || 0;
  }
  saveData();
}

function enhanceWeapon(id, success, destroyed) {
  if (!weapons[id]) return false;
  
  if (!weapons[id].enhancements) {
    weapons[id].enhancements = { '가시': 0, '껍질': 0 };
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
  
  const maxHp = 50 + (newLevel * 10);
  const attack = 10 + (newLevel * 2);
  const defense = 10 + (newLevel * 2);
  const currentHp = char.current_hp + ((newLevel - char.level) * 10);
  
  char.level = newLevel;
  char.exp = newExp;
  char.max_hp = maxHp;
  char.current_hp = Math.min(currentHp, maxHp);
  char.attack = attack;
  char.defense = defense;
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
      characters[id] = { name: '모험가', level: 0, exp: 0, current_hp: 50, max_hp: 50, attack: 10, defense: 10 };
    }
    characters[id].current_hp = characters[id].max_hp;
    user.last_heal_date = today;
    saveData();
    return true;
  }
  return false;
}

// 땅굴(던전) 관련 함수 - 체력만 사용
function enterDungeon(id) {
  const user = getOrCreateUser(id);
  const char = getOrCreateCharacter(id);
  
  if (user.in_dungeon) {
    return { success: false, message: '이미 땅굴에 있습니다.' };
  }
  
  user.in_dungeon = true;
  if (user.dungeon_floor === 0) {
    user.dungeon_floor = 1;
  }
  saveData();
  return { success: true, floor: user.dungeon_floor };
}

function exitDungeon(id) {
  const user = getOrCreateUser(id);
  if (!user.in_dungeon) {
    return { success: false, message: '땅굴에 있지 않습니다.' };
  }
  user.in_dungeon = false;
  saveData();
  return { success: true, floor: user.dungeon_floor };
}

function resetDungeon(id) {
  const user = getOrCreateUser(id);
  user.in_dungeon = false;
  user.dungeon_floor = 0;
  saveData();
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
  getWeapon, equipWeapon, enhanceWeapon,
  addExp, updateCharacterName, resetBattleCount, incrementBattle, getBattleCount,
  findUserByName, getRandomCharacterId, decreaseHp, healHp, fullHeal, checkDailyHeal,
  enterDungeon, exitDungeon, resetDungeon,
  advanceDungeonFloor, getDungeonFloor, isInDungeon
};
