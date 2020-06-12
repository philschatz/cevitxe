﻿import { ChangeSet, SnapshotRecord } from '@philschatz/cevitxe-types'

export abstract class StorageAdapter {
  storageKey: string

  constructor(options: { discoveryKey: string; databaseName: string }) {
    const { databaseName, discoveryKey } = options
    this.storageKey = `cevitxe_${databaseName}_${discoveryKey.substr(0, 12)}`
  }

  abstract async open(): Promise<void>
  abstract async close(): Promise<void>
  abstract async hasData(): Promise<boolean>

  abstract changes(): AsyncIterableIterator<ChangeSet>
  abstract async getChanges(documentId: string): Promise<ChangeSet[]>
  abstract async appendChanges(changeSet: ChangeSet): Promise<void>

  abstract snapshots(): AsyncIterableIterator<SnapshotRecord>
  abstract async putSnapshot(snapshotRecord: SnapshotRecord): Promise<void>
  abstract async deleteSnapshot(snapshotId: string): Promise<void>
}
