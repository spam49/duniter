"use strict";

var util = require('util');
var es = require('event-stream');
var stream      = require('stream');
var _ = require('underscore');
var Q = require('q');
let co = require('co');
let ucoin = require('../../index');
let ucp = require('../lib/ucp');
let constants = require('../lib/constants');
let base58 = require('../lib/base58');
let rawer = require('../lib/rawer');
let crypto = require('../lib/crypto');
let http2raw = require('../lib/streams/parsers/http2raw');
let parsers = require('../lib/streams/parsers/doc');
let bma = require('../lib/streams/bma');
let Identity = require('../lib/entity/identity');
let network = require('../lib/network');
let AbstractController = require('../controllers/abstract');
var Synchroniser = require('../lib/sync');
var logger = require('../lib/logger')('webmin');

module.exports = (dbConf, overConf) => new WebAdmin(dbConf, overConf);

function WebAdmin (dbConf, overConf) {

  // Node instance: this is the object to be managed by the web admin
  let server = this.server = ucoin(dbConf, overConf);
  let bmapi;
  let that = this;

  AbstractController.call(this, server);

  stream.Duplex.call(this, { objectMode: true });

  // Unused, but made mandatory by Duplex interface
  this._read = () => null;
  this._write = () => null;

  let startServicesP, stopServicesP;

  let pluggedConfP = co(function *() {
    yield server.plugFileSystem();
    yield server.loadConf();
    bmapi = yield bma(server, null, true);
  });

  let pluggedDALP = co(function *() {
    yield pluggedConfP;
    yield server.initDAL();
  });

  this.summary = () => co(function *() {
    yield pluggedDALP;
    let host = server.conf ? [server.conf.ipv4, server.conf.port].join(':') : '';
    let current = yield server.dal.getCurrentBlockOrNull();
    return {
      "host": host,
      "current": current
    };
  });

  this.startHTTP = () => co(function *() {
    yield pluggedDALP;
    return bmapi.openConnections();
  });

  this.stopHTTP = () => co(function *() {
    yield pluggedDALP;
    return bmapi.closeConnections();
  });

  this.previewNext = () => co(function *() {
    yield pluggedDALP;
    let block = yield server.doMakeNextBlock();
    block.raw = rawer.getBlock(block);
    return block;
  });

  this.sendConf = (req) => co(function *() {
    yield pluggedConfP;
    let conf = http2raw.conf(req);
    let pair = yield Q.nbind(crypto.getKeyPair, crypto)(conf.idty_entropy, conf.idty_password);
    let publicKey = base58.encode(pair.publicKey);
    let secretKey = pair.secretKey;
    yield server.dal.saveConf({
      routing: true,
      createNext: true,
      cpu: 0.5,
      ipv4: conf.local_ipv4,
      ipv6: conf.local_ipv6,
      port: conf.lport,
      remoteipv4: conf.remote_ipv4,
      remoteipv6: conf.remote_ipv6,
      remoteport: conf.rport,
      upnp: conf.upnp,
      salt: conf.idty_entropy,
      passwd: conf.idty_password,
      pair: {
        pub: publicKey,
        sec: base58.encode(secretKey)
      },
      avgGenTime: conf.avgGenTime,
      blocksRot: conf.blocksRot,
      c: conf.c,
      currency: conf.currency,
      dt: conf.dt,
      dtDiffEval: conf.dtDiffEval,
      idty_entropy: conf.idty_entropy,
      idty_password: conf.idty_password,
      idty_uid: conf.idty_uid,
      medianTimeBlocks: conf.medianTimeBlocks,
      msValidity: conf.msValidity,
      percentRot: conf.percentRot,
      sigDelay: conf.sigDelay,
      sigPeriod: conf.sigPeriod,
      sigQty: conf.sigQty,
      sigStock: conf.sigStock,
      sigValidity: conf.sigValidity,
      sigWindow: conf.sigWindow,
      stepMax: conf.stepMax,
      ud0: conf.ud0,
      xpercent: conf.xpercent
    });
    pluggedConfP = co(function *() {
      yield bmapi.closeConnections();
      yield server.loadConf();
      bmapi = yield bma(server, null, true);
      return bmapi.openConnections();
    });
    yield pluggedConfP;
    let buid = '0-E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';
    let entity = Identity.statics.fromJSON({
      buid: buid,
      uid: conf.idty_uid,
      issuer: publicKey,
      currency: conf.currency
    });
    let found = yield server.dal.getIdentityByHashOrNull(entity.getTargetHash());
    if (!found) {
      let selfCert = rawer.getOfficialIdentity(entity);
      selfCert += crypto.signSync(selfCert, secretKey);
      found = yield that.pushEntity({ body: { identity: selfCert }}, http2raw.identity, parsers.parseIdentity);
    }
    yield server.dal.fillInMembershipsOfIdentity(Q(found));
    if (_.filter(found.memberships, { membership: 'IN'}).length == 0) {
      var block = ucp.format.buid(null);
      var join = rawer.getMembershipWithoutSignature({
        "version": constants.DOCUMENTS_VERSION,
        "currency": conf.currency,
        "issuer": publicKey,
        "block": block,
        "membership": "IN",
        "userid": conf.idty_uid,
        "certts": block
      });
      join += crypto.signSync(join, secretKey) + '\n';
      yield that.pushEntity({ body: { membership: join }}, http2raw.membership, parsers.parseMembership);
    }
    //
    return found;
  });

  this.listInterfaces = () => co(function *() {
    let upnp = {
      name: 'upnp',
      addresses: []
    };
    let manual = {
      name: 'conf',
      addresses: []
    };
    yield pluggedConfP;
    let conf = server.conf;
    if (conf.remoteipv4) {
      manual.addresses.push({ family: 'IPv4', address: conf.remoteipv4 });
    }
    if (conf && conf.remoteipv6) {
      manual.addresses.push({ family: 'IPv6', address: conf.remoteipv6 });
    }
    let upnpConf;
    try {
      upnpConf = yield network.upnpConf();
      if (upnpConf.remoteipv4) {
        upnp.addresses.push({
          family: 'IPv4',
          address: upnpConf.remoteipv4
        });
      }
      if (upnpConf.remoteipv6) {
        upnp.addresses.push({
          family: 'IPv6',
          address: upnpConf.remoteipv6
        });
      }
    } catch (e) {
      logger.error(e.stack || e);
    }
    let randomPort = network.getRandomPort();
    return {
      local: network.listInterfaces(),
      remote: [upnp, manual],
      auto: {
        local: {
          ipv4: network.getBestLocalIPv4(),
          ipv6: network.getBestLocalIPv6(),
          port: randomPort
        },
        remote: {
          ipv4: upnpConf && upnpConf.remoteipv4,
          ipv6: upnpConf && upnpConf.remoteipv6,
          dns: '',
          port: randomPort,
          upnp: upnpConf ? true : false
        }
      }
    };
  });

  this.startAllServices = () => co(function *() {
    // Allow services to be stopped
    stopServicesP = null;
    yield startServicesP || (startServicesP = ucoin.statics.startServices(server));
    that.push({ started: true });
    return {};
  });

  this.stopAllServices = () => co(function *() {
    // Allow services to be started
    startServicesP = null;
    yield stopServicesP || (stopServicesP = ucoin.statics.stopServices(server));
    that.push({ stopped: true });
    return {};
  });

  this.autoConfNetwork = () => co(function *() {
    let bestLocal4 = network.getBestLocalIPv4();
    let bestLocal6 = network.getBestLocalIPv6();
    let upnpConf = {
      remoteipv4: bestLocal4,
      remoteipv6: bestLocal6,
      upnp: false
    };
    try {
      upnpConf = yield network.upnpConf();
      upnpConf.upnp = true;
    } catch (e) {
      logger.error(e.stack || e);
    }
    let randomPort = network.getRandomPort();
    _.extend(server.conf, {
      ipv4: bestLocal4,
      ipv6: bestLocal6,
      port: randomPort,
      remoteipv4: upnpConf.remoteipv4,
      remoteipv6: upnpConf.remoteipv6,
      remoteport: randomPort,
      upnp: upnpConf.upnp
    });
    yield server.dal.saveConf(server.conf);
    pluggedConfP = co(function *() {
      yield bmapi.closeConnections();
      yield server.loadConf();
      bmapi = yield bma(server, null, true);
    });
    return {};
  });

  this.startSync = (req) => co(function *() {
    // Synchronize
    var remote = new Synchroniser(server, req.body.host, parseInt(req.body.port), server.conf, false);
    remote.pipe(es.mapSync(function(data) {
      // Broadcast block
      that.push(data);
    }));
    yield remote.sync();
    logger.info('Sync finished.');
    return {};
  });
}

util.inherits(WebAdmin, stream.Duplex);