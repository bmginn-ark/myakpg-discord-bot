// 간단한 파일 기반 데이터베이스: Railway 데이터 볼륨에 저장
const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, 'data.json');

// 데이터 로드 함수 (봇 시작 시 호출)
function loadData() {
  try {
    if (fs.existsSync(dataFile)) {
      const rawData = fs.readFileSync(dataFile, 'utf8');
      return JSON.parse(rawData);
    }
  } catch (error) {
    console.error('데이터 로드 오류:', error);
  }
  // 기본 빈 데이터 구조
  return { users: {}, characters: {}, weapons: {}, inventories: {}, skills: {} };
}

// 데이터 저장 함수 (변경 시 호출)
function saveData() {
  try {
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('데이터 저장 오류:', error);
  }
}

// 데이터 객체 초기화
let data = loadData();

// 사용자 관련 함수
function getOrCreateUser(id) {
  if (!data.users[id]) data.users[id] = { dust: 0, last_attendance_date: null, last_exploration_date: null, exploration_count: 0 };
  return data.users[id];
}

function getOrCreateCharacter(id) {
  if (!data.characters[id]) {
    data.characters[id] = {
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
  return data.characters[id];
}

function getInventory(id) {
  if (!data.inventories[id]) data.inventories[id] = [];
  return data.inventories[id];
}

function addDust(id, amount) { getOrCreateUser(id).dust += amount; saveData(); }
function subtractDust(id, amount) { getOrCreateUser(id).dust = Math.max(0, getOrCreateUser(id).dust - amount); saveData(); }

function setAttendance(id, date) { getOrCreateUser(id).last_attendance_date = date; saveData(); }
function resetExplorationCount(id) { getOrCreateUser(id).exploration_count = 0; saveData(); }
function incrementExploration(id) { getOrCreateUser(id).exploration_count = (getOrCreateUser(id).exploration_count || 0) + 1; saveData(); }

function addItem(id, name, type = 'item', qty = 1) {
  const inv = getInventory(id);
  const it = inv.find(i => i.item_name === name);
  if (it) it.quantity += qty; else inv.push({ item_name: name, item_type: type, quantity: qty });
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

function getWeapon(id) { return data.weapons[id] || null; }
function equipWeapon(id, type) { data.weapons[id] = { weapon_type: type, enhancement: 0 }; saveData(); }
function enhanceWeapon(id, success, destroyed) {
  if (!data.weapons[id]) return null;
  if (destroyed) { delete data.weapons[id]; saveData(); return { destroyed: true }; }
  if (success) { data.weapons[id].enhancement = Math.min(20, data.weapons[id].enhancement + 1); saveData(); return { newLevel: data.weapons[id].enhancement }; }
  saveData();
  return { newLevel: data.weapons[id].enhancement };
}

function getOrCreateSkill(id) {
  if (!data.skills[id]) data.skills[id] = { skill_name: '기본 스킬', skill_level: 1 };
  return data.skills[id];
}
function enhanceSkill(id, success) { if (!data.skills[id]) getOrCreateSkill(id); if (success) data.skills[id].skill_level += 1; saveData(); }

// 레벨업: 필요 경험치 = (현재 레벨 + 1) × 5 (최대 레벨 20)
function addExp(id, amount) {
  const char = getOrCreateCharacter(id);
  const oldLevel = char.level;
  char.exp += amount;
  const need = (char.level + 1) * 5;
  if (char.exp >= need && char.level < 20) {
    char.exp -= need;
    char.level += 1;
    char.max_hp = 50 + (char.level * 10);
    char.attack = 10 + (char.level * 2);
    char.defense = 10 + (char.level * 2);
    char.current_hp = Math.min(char.current_hp + 10, char.max_hp);
  }
  saveData();
  return { leveledUp: char.level > oldLevel, oldLevel, newLevel: char.level };
}

function updateCharacterName(id, name) { getOrCreateCharacter(id).name = name; saveData(); }

module.exports = {
  getOrCreateUser, getOrCreateCharacter, addDust, subtractDust, setAttendance,
  resetExplorationCount, incrementExploration, addItem, removeItem, getInventory,
  getWeapon, equipWeapon, enhanceWeapon, getOrCreateSkill, enhanceSkill,
  addExp, updateCharacterName, loadData, saveData
};