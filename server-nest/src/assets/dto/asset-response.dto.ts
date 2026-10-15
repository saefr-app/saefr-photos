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
