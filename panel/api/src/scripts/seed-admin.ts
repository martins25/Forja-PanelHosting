import { getDB } from "../db/connection.js";
import { migrate } from "../db/connection.js";
import { users } from "../db/schema.js";
import { hashPassword } from "../auth/crypto.js";
import { loadAppKey } from "../auth/crypto.js";
import { eq } from "drizzle-orm";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  try {
    loadAppKey();
  } catch {
    console.error("Error: cannot load app key. Make sure /etc/forja/app.key exists.");
    process.exit(1);
  }

  migrate();
  const db = getDB();

  const email = await ask("Admin email: ");
  if (!email || !email.includes("@")) {
    console.error("Invalid email");
    process.exit(1);
  }

  const existing = db.select().from(users).where(eq(users.email, email)).get();
  if (existing) {
    console.error(`User ${email} already exists`);
    process.exit(1);
  }

  const password = await ask("Password (min 8 chars): ");
  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  db.insert(users)
    .values({
      email,
      role: "admin",
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    })
    .run();

  console.log(`Admin user ${email} created successfully.`);
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
