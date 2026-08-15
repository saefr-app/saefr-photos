import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Library } from './library.entity';
import { User } from './user.entity';

export type AssetStatus = 'uploaded' | 'processing' | 'done';

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Assets belong to a Library, NOT to a user. There is intentionally no
   * `userId` column here — see Library entity for the reasoning. Access is
   * resolved through LibraryMembership at request time.
   */
  @Index()
  @Column('uuid')
  libraryId: string;

  @ManyToOne(() => Library, (library) => library.assets, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'libraryId' })
  library: Library;

  /**
   * Informational only — who pushed the bytes. This confers no ownership and is
   * never consulted for authorisation.
   */
  @Column('uuid')
  uploadedBy: string;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'uploadedBy' })
  uploader: User;

  /** Path of the file relative to UPLOADS_DIR inside the mounted volume. */
  @Column()
  storageKey: string;

  @Column()
  originalFilename: string;

  @Column()
  mimeType: string;

  // pg returns bigint as a string; transform back to a number so API responses
  // stay JSON-numeric. Safe well beyond any realistic single-file size.
  @Column({
    type: 'bigint',
    transformer: {
      to: (value: number) => value,
      from: (value: string) => (value === null ? null : Number(value)),
    },
  })
  sizeBytes: number;

  /**
   * SHA-1 of the uploaded bytes. Captured now, NOT enforced — deduplication is
   * deliberately deferred. Enabling it later is one lookup in AssetsService
   * before the save: findOne({ where: { checksum, libraryId } }).
   */
  @Index()
  @Column({ type: 'varchar', length: 40, nullable: true })
  checksum: string | null;

  @Column({ type: 'varchar', length: 16, default: 'uploaded' })
  status: AssetStatus;

  @CreateDateColumn()
  createdAt: Date;
}
