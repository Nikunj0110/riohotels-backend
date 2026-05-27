export class WhatsAppMongoAuthStore {
  constructor({ db, collectionName = "whatsappSessions" } = {}) {
    if (!db) {
      throw new Error("A MongoDB database handle is required for auth store");
    }

    this.db = db;
    this.collectionName = collectionName;
  }

  collection() {
    return this.db.collection(this.collectionName);
  }

  async ensureIndexes() {
    await this.collection().createIndex({ sessionId: 1 }, { unique: true });
    await this.collection().createIndex({ updatedAt: 1 });
  }

  async load({ session }) {
    const document = await this.collection().findOne(
      { sessionId: session },
      { projection: { _id: 0, sessionData: 1 } },
    );

    return document?.sessionData || null;
  }

  async save({ session, sessionData }) {
    if (!sessionData) return;

    await this.collection().updateOne(
      { sessionId: session },
      {
        $set: {
          sessionId: session,
          sessionData,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async delete({ session }) {
    await this.collection().deleteOne({ sessionId: session });
  }
}
