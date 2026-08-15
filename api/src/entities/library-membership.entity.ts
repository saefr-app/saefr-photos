import { Entity, JoinColumn, ManyToOne, PrimaryColumn, Column } from 'typeorm';
import { Library } from './library.entity';
import { User } from './user.entity';

export type LibraryRole = 'owner' | 'contributor' | 'viewer';

/**
 * Join row between User and Library, carrying the user's role in that library.
 * Composite primary key (userId, libraryId) — a user holds at most one role per
 * library. This table is the single authorisation point for asset access.
 */
@Entity('library_memberships')
export class LibraryMembership {
  @PrimaryColumn('uuid')
  userId: string;

  @PrimaryColumn('uuid')
  libraryId: string;

  @Column({ type: 'varchar', length: 32 })
  role: LibraryRole;

  @ManyToOne(() => User, (user) => user.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => Library, (library) => library.memberships, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'libraryId' })
  library: Library;
}
