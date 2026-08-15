import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Asset } from './asset.entity';
import { LibraryMembership } from './library-membership.entity';

/**
 * A Library is the unit that owns assets. Users do NOT own assets directly —
 * they hold a role in a Library via LibraryMembership.
 *
 * This is deliberate: tying every asset to exactly one owning user (the Immich
 * model) forces duplicate ML processing for every viewer of a shared photo and
 * makes cross-user face matching impossible. Assets belong to a Library so a
 * single stored file is processed once and shared by membership.
 */
@Entity('libraries')
export class Library {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => LibraryMembership, (membership) => membership.library)
  memberships: LibraryMembership[];

  @OneToMany(() => Asset, (asset) => asset.library)
  assets: Asset[];
}
