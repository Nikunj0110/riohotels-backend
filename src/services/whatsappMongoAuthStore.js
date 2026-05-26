import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { GridFSBucket } from "mongodb";

export class WhatsAppMongoAuthStore {
  constructor({ db, dataPath, bucketName = "whatsappAuthSessions" } = {}) {
    if (!db) {
      throw new Error("A MongoDB database handle is required for auth store");
    }

    if (!dataPath) {
      throw new Error("A dataPath is required for auth store");
    }

    this.db = db;
    this.dataPath = path.resolve(dataPath);
    this.bucketName = bucketName;
  }

  async sessionExists({ session }) {
    const count = await this.db
      .collection(`${this.bucketName}.files`)
      .countDocuments({ filename: this.getSessionFilename(session) });

    return count > 0;
  }

  async save({ session }) {
    const bucket = this.getBucket();
    const filename = this.getSessionFilename(session);
    const archivePath = this.getSessionArchivePath(session);

    await new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(filename, {
        metadata: { session },
      });

      createReadStream(archivePath)
        .on("error", reject)
        .pipe(uploadStream)
        .on("error", reject)
        .on("finish", resolve);
    });

    await this.deletePrevious({ bucket, session });
  }

  async extract({ session, path: outputPath }) {
    const bucket = this.getBucket();
    const filename = this.getSessionFilename(session);

    await new Promise((resolve, reject) => {
      bucket
        .openDownloadStreamByName(filename)
        .on("error", reject)
        .pipe(createWriteStream(outputPath))
        .on("error", reject)
        .on("finish", resolve);
    });
  }

  async delete({ session }) {
    const bucket = this.getBucket();
    const filename = this.getSessionFilename(session);
    const documents = await bucket.find({ filename }).toArray();

    await Promise.allSettled(
      documents.map((document) => bucket.delete(document._id)),
    );
  }

  getBucket() {
    return new GridFSBucket(this.db, { bucketName: this.bucketName });
  }

  getSessionFilename(session) {
    return `${session}.zip`;
  }

  getSessionArchivePath(session) {
    return path.join(this.dataPath, this.getSessionFilename(session));
  }

  async deletePrevious({ bucket, session }) {
    const filename = this.getSessionFilename(session);
    const documents = await bucket.find({ filename }).sort({ uploadDate: -1 }).toArray();

    if (documents.length <= 1) return;

    await Promise.allSettled(
      documents.slice(1).map((document) => bucket.delete(document._id)),
    );
  }
}
