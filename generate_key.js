#!/usr/bin/env node
// generate_key.js - Консольная утилита выпуска ключей klyaksa PRO
const db = require('./db.js');

const args = process.argv.slice(2);
const count = args.length === 0 ? 1 : Number(args[0]);

if (!Number.isSafeInteger(count) || count <= 0) {
  console.error('Ошибка: количество ключей должно быть положительным числом.');
  console.log('Использование: node generate_key.js [количество]');
  process.exit(1);
}

console.log('='.repeat(56));
console.log(`  ГЕНЕРАЦИЯ КЛЮЧЕЙ klyaksa PRO (${count} шт.)`);
console.log('='.repeat(56));

async function main() {
const createdKeys = [];
for (let i = 0; i < count; i++) {
  const lic = await db.createLicense('cli_admin', 'ProLifetime');
  createdKeys.push(lic.key);
  console.log(`  [${i + 1}/${count}]  ${lic.key}`);
}

console.log('-'.repeat(56));
console.log('  Все ключи успешно сохранены в выбранной базе данных со статусом "available".');
console.log('  Ссылка для быстрой активации в 1 клик:');
console.log(`  klyaksa://activate?key=${createdKeys[0]}`);
console.log('='.repeat(56));

}
main().catch(err => { console.error('Ошибка работы с БД:', err.message); process.exitCode = 1; });
