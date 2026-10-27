import { ApiProperty } from '@nestjs/swagger';

export class AssetResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: 'ab35d140-c846-4c7a-8cf8-9d72aa26f188',
  })
  id!: string;

  @ApiProperty({
    example: 'holiday.jpg',
  })
  filename!: string;

  @ApiProperty({
    example: 'image/jpeg',
    enum: ['image/jpeg', 'image/png', 'image/webp'],
  })
  mime_type!: string;

  @ApiProperty({
    type: 'integer',
    example: 93217,
  })
  size!: number;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-15T22:42:24.313Z',
  })
  created_at!: string;
}

export class AssetPageItemDto extends AssetResponseDto {
  @ApiProperty({ example: '0', description: 'Decimal lifecycle version' })
  lifecycle_version!: string;
}

export class TrashPageItemDto extends AssetPageItemDto {
  @ApiProperty({
    format: 'date-time',
    example: '2026-10-26T10:10:00.123456Z',
  })
  trashed_at!: string;
}

export class AssetPageDto {
  @ApiProperty({ type: [AssetPageItemDto] })
  items!: AssetPageItemDto[];

  @ApiProperty({ nullable: true, type: String, example: null })
  next_cursor!: string | null;
}

export class TrashPageDto {
  @ApiProperty({ type: [TrashPageItemDto] })
  items!: TrashPageItemDto[];

  @ApiProperty({ nullable: true, type: String, example: null })
  next_cursor!: string | null;
}

export class PendingDeletionDto {
  @ApiProperty({ format: 'uuid' })
  asset_id!: string;

  @ApiProperty({ enum: ['pending'], example: 'pending' })
  status!: 'pending';

  @ApiProperty({ format: 'date-time', example: '2026-10-26T10:15:00.123456Z' })
  requested_at!: string;

  @ApiProperty({ nullable: true, type: String, example: null })
  completed_at!: null;

  @ApiProperty({ nullable: true, type: String, example: 'storage_unavailable' })
  last_error_code!: string | null;
}

export class PendingDeletionPageDto {
  @ApiProperty({ type: [PendingDeletionDto] })
  items!: PendingDeletionDto[];

  @ApiProperty({ nullable: true, type: String, example: null })
  next_cursor!: string | null;
}

export class LifecycleTransitionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['active', 'trashed'], example: 'trashed' })
  state!: 'active' | 'trashed';

  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-10-26T10:10:00.123456Z',
  })
  trashed_at!: string | null;

  @ApiProperty({ example: '5', description: 'Decimal lifecycle version' })
  lifecycle_version!: string;
}
