import 'source-map-support/register';
import 'reflect-metadata';

import * as Koa from 'koa';
import * as Router from 'koa-router';
import * as _ from 'lodash';
import * as bodyParser from 'koa-bodyparser';
import * as glob from 'glob';

import {
  ControllerOptions,
  Decorator,
  MethodParamMeta,
  MethodParamMetas,
  RequestMethod,
  RequestParamMeta,
  RouterDetail,
} from './meta/index';

import { RequestParamError } from './error/index';
import { validateValue } from './validation/index';

const Multer = require('koa-multer');

export * from './decorators/Controller';
export * from './decorators/Get';
export * from './decorators/Post';
export * from './decorators/Ctx';
export * from './decorators/RequestParam';
export * from './decorators/Before';
export * from './interfaces/Middleware';

const router = new Router();
const controllers: { [key: string]: any } = {};
const controllerMethodRouters: { [key: string]: { [key: string]: RouterDetail } } = {};
const controllerMethodParamMetas: { [key: string]: { [key: string]: MethodParamMetas } } = {};
let controllerOptions: ControllerOptions;
let multer: any;

export interface MultipartFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  destination: string;
  filename: string;
  path: string;
  size: number;
  buffer?: any;
}

export function useControllers(app: Koa, controllerFiles: string, options: ControllerOptions) {
  controllerOptions = options;
  multer = Multer(options.multipart);
  app.use(bodyParser());
  const files = glob.sync(controllerFiles);
  _.each(files, (file: any) => {
    require(file);
  });
  _.each(controllerMethodRouters, (routers) => {
    _.each(routers, (routerDetail) => {
      (router as any)[routerDetail.requestMethod](
        routerDetail.path, ...createRouterHandler(routerDetail));
    });
  });
  app.use(router.routes())
    .use(router.allowedMethods());
}

export function addRouter(path: string, target: any, propertyKey: string, method: RequestMethod) {
  const controllerName = target.constructor.name;
  const methodRouters = getMethodRouters(controllerName);
  const metas = controllerMethodParamMetas[controllerName] ?
    controllerMethodParamMetas[controllerName][propertyKey] : undefined;
  const paramTypes = Reflect.getMetadata('design:paramtypes', target, propertyKey);
  methodRouters[propertyKey] = _.merge(methodRouters[propertyKey], {
    path,
    paramTypes,
    requestMethod: method,
    controller: controllerName,
    controllerMethod: propertyKey,
    methodParamMetas: metas,
  });
}

export function addRouterMiddleware(middleware: any, target: any, propertyKey: string) {
  const controllerName = target.constructor.name;
  const methodRouters = getMethodRouters(controllerName);
  let existBefores = false;
  if (methodRouters[propertyKey]) {
    const befores = methodRouters[propertyKey].befores;
    if (befores) {
      existBefores = true;
      befores.push(middleware);
    }
  }
  if (!existBefores) {
    methodRouters[propertyKey] = _.merge(methodRouters[propertyKey], {
      befores: [middleware],
    });
  }
}

export function addController(target: any) {
  controllers[target.name] = new target();
}

export function addParam(target: any, propertyKey: string, index: number,
  injector: Decorator, meta?: RequestParamMeta) {

  const params = getMethodParams(target, propertyKey);
  params[index] = {
    decorator: injector,
    additionalMeta: meta,
  };
}

function createRouterHandler(routerDetail: RouterDetail): any {
  const handlers: any[] = [];
  if (routerDetail.befores) {
    _.each(routerDetail.befores, (before) => {
      handlers.push((new (before as any)()).middleware);
    });
  }
  handlers.push(async (ctx: any, next: any) => {
    try {
      await controllers[routerDetail.controller][routerDetail.controllerMethod].apply(
        controllers[routerDetail.controller], await getHandlerInjectParams(ctx, routerDetail));
    } catch (error) {
      if (error instanceof RequestParamError) {
        ctx.throw(400, error.message);
      } else {
        throw error;
      }
    }

    await next();
  });
  return handlers;
}

async function getHandlerInjectParams(ctx: any, routerDetail: RouterDetail): Promise<any[]> {
  if (routerDetail.methodParamMetas == null) {
    return [];
  } else {
    const params: any[] = [];
    if (isMultipart(ctx)) {
      await uploadMultipartFile(ctx, routerDetail);
    }

    for (let i = 0, len = _.size(routerDetail.methodParamMetas); i < len; i += 1) {
      const paramMeta = routerDetail.methodParamMetas[i];
      const paramType = routerDetail.paramTypes[i].name.toLowerCase();
      switch (paramMeta.decorator) {
        case 'ctx':
          params.push(ctx);
          break;
        case 'request-param':
          const requestParamMeta = paramMeta.additionalMeta as RequestParamMeta;
          if (requestParamMeta == null) {
            throw new RequestParamError('request param options should not be null');
          }

          let parsedValue = getRequestParam(ctx, paramType, requestParamMeta);
          if (parsedValue == null) {
            if (!isNotRequired(requestParamMeta)) {
              const defaultValue = getDefault(requestParamMeta);
              if (defaultValue == null) {
                throw new RequestParamError('required request param is not present: ' + requestParamMeta.name);
              }
              parsedValue = defaultValue;
            }
          }
          params.push(parsedValue);
          break;
        default:
          throw new Error('unsupport param injector: ' + paramMeta.decorator);
      }
    }
    return params;
  }
}

async function uploadMultipartFile(ctx: any, routerDetail: RouterDetail) {
  const fileFields = getRouterFileFields(routerDetail);
  await multer.fields(fileFields)(ctx);
}

type FileFields = { name: string, maxCount?: number }[];

function getRouterFileFields(routerDetail: RouterDetail): FileFields {
  const fileFields: FileFields = [];
  if (routerDetail.methodParamMetas != null) {
    _.each(routerDetail.methodParamMetas, (paramMeta: MethodParamMeta) => {
      if (paramMeta.decorator === 'request-param'
        && paramMeta.additionalMeta != null
        && paramMeta.additionalMeta.options != null
        && paramMeta.additionalMeta.options.file === true) {
        fileFields.push({
          name: paramMeta.additionalMeta.name,
        });
      }
    });
  }

  return fileFields;
}

function getUploadFile(ctx: any, requestParamMeta: RequestParamMeta): any {
  if (_.isObject(ctx.req.files) && _.isArray(ctx.req.files[requestParamMeta.name])) {
    const files = ctx.req.files[requestParamMeta.name];
    if (requestParamMeta.options && requestParamMeta.options.multiple) {
      return files;
    } else {
      return files[0];
    }
  }
}

function isFile(meta: RequestParamMeta): boolean {
  return !!(meta && meta.options && meta.options.file);
}

function getRequestParam(ctx: any, paramType: string, meta: RequestParamMeta): any {
  if (isFile(meta)) {
    return getUploadFile(ctx, meta);
  }

  if (meta === null) {
    return undefined;
  }

  let value: any;

  if (ctx.req.method === 'GET') {
    value = ctx.query[meta.name];
  } else if (isWwwFormUrlencoded(ctx)) {
    value = ctx.request.body[meta.name];
  } else if (isJson(ctx)) {
    value = ctx.request.body[meta.name];
  } else if (isMultipart(ctx)) {
    value = ctx.req.body[meta.name];
  }

  if (value != null) {
    const convertedValue = convertValue(value, paramType, meta);
    validateValue(convertedValue, paramType, meta);
    return convertedValue;
  }
}

function isWwwFormUrlencoded(ctx: any): boolean {
  const contentType = ctx.headers['content-type'];
  return contentType === 'application/x-www-form-urlencoded';
}

function isMultipart(ctx: any): boolean {
  const contentType = ctx.headers['content-type'];
  return typeof contentType === 'string' && contentType.indexOf('multipart/form-data') !== -1;
}

function isJson(ctx: any) {
  const contentType = ctx.headers['content-type'];
  return contentType === 'application/json';
}

function convertValue(value: any, paramType: string, meta: RequestParamMeta): any {
  if (meta.options != null && meta.options.enum != null) {
    return meta.options.enum[value];
  }

  switch (paramType) {
    case 'number':
      if (value === '') {
        return undefined;
      } else {
        const number = +value;
        if (isNaN(number)) {
          throw new RequestParamError('request param parse fail: invalid number: ' + value);
        }
        return number;
      }
    case 'string':
      return value;
    case 'boolean':
      if (value === 'true') {
        return true;
      } else if (value === 'false') {
        return false;
      } else {
        return !!value;
      }
    default:
      return value;
  }
}

function isNotRequired(meta: RequestParamMeta): boolean {
  return !!(meta && meta.options && meta.options.required === false);
}

function getDefault(meta: RequestParamMeta): any {
  if (meta && meta.options) {
    return meta.options.default;
  }
}

function getMethodParams(target: any, propertyKey: string): MethodParamMetas {
  const controllerName = target.constructor.name;
  if (controllerMethodParamMetas[controllerName] == null) {
    controllerMethodParamMetas[controllerName] = {};
  }
  if (controllerMethodParamMetas[controllerName][propertyKey] == null) {
    controllerMethodParamMetas[controllerName][propertyKey] = {};
  }
  return controllerMethodParamMetas[controllerName][propertyKey];
}

function getMethodRouters(controllerName: string): { [key: string]: RouterDetail } {
  if (controllerMethodRouters[controllerName] == null) {
    controllerMethodRouters[controllerName] = {};
  }
  return controllerMethodRouters[controllerName];
}
