# Copilot Instructions for MyakPG Discord RPG Bot

## Project Overview
This is a Korean-language Discord RPG bot built with Node.js. Players can create characters, explore, battle, manage inventory, and enhance weapons/skills through Discord commands.

## Architecture
- **Entry Point**: `index.js` - Contains all bot logic, command handlers, and game mechanics
- **Data Layer**: `database.js` - In-memory data store (persistence not yet implemented)
- **Configuration**: `.env` for `DISCORD_TOKEN` and `GEMINI_API_KEY`
- **Data Structure**: `data.json` contains sample user/character data with nested objects for users, characters, weapons, inventories, skills

## Key Patterns
- **Command Structure**: All commands start with `!` followed by Korean verbs (e.g., `!출석`, `!탐험`)
- **Reward Calculations**: Use probability-based random rewards with tiered chances (e.g., `calculateAttendanceReward()` returns 100 default, 500/50/2000 with decreasing probabilities)
- **Embed Responses**: Use `EmbedBuilder` for rich Discord responses with colors, fields, and timestamps
- **Data Access**: All data operations through `db.*` functions (currently in-memory)
- **Async Operations**: Gemini API calls for exploration comments, with fallback to static messages

## Game Mechanics
- **Currency**: "먼지" (dust) earned from attendance/exploration
- **Progression**: Experience points for leveling (need = (level+1) * 5 exp)
- **Weapons**: Three types (검/방패/지팡이) with enhancement system (+2 stat per level, decreasing success rates)
- **Skills**: Enhanceable with "강화석" items, success rates decrease with skill level
- **Inventory**: Items stored with name, type, quantity; sent via DM for privacy

## Development Workflow
- **Run**: `npm start` or `node index.js`
- **Environment**: Requires `.env` with Discord bot token; Gemini API optional for flavor text
- **Persistence**: Currently missing - implement SQLite with `better-sqlite3` to save/load from `data.json` structure
- **Testing**: No automated tests; manually test commands in Discord

## Common Tasks
- **Add New Command**: Add case in `messageCreate` switch, implement handler function
- **Modify Rewards**: Update calculation functions (e.g., `calculateExplorationReward()` for dust/item chances)
- **Add Persistence**: Replace `database.js` with SQLite queries, load/save JSON on startup/shutdown
- **Balance Changes**: Adjust probabilities in enhancement/skill functions for game difficulty

## Code Style
- Single-file architecture with functions for each command
- Korean strings for user-facing messages
- Error handling with try/catch in message handler
- Admin checks for privileged commands like `!지급`