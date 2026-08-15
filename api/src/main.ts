import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // The upload/test page, served off the same port as the API. Deliberately a
  // plain static page rather than a separate frontend container — the real web
  // app is its own milestone. dist/ sits one level below the app root.
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // whitelist strips properties without a validation decorator, so the DTO
  // rules (@IsEmail, @MinLength) are the actual contract for request bodies.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');

  Logger.log(`Saefr Photos API listening on port ${port}`, 'Bootstrap');
}

bootstrap();
