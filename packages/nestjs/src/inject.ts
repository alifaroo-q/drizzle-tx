import { Inject } from '@nestjs/common';
import { DRIZZLE_TX_CLIENT } from './tokens.js';

export const InjectTransactionalClient = (): ParameterDecorator => Inject(DRIZZLE_TX_CLIENT);
