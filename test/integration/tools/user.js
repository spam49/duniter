"use strict";
var Q		    = require('q');
var async		= require('async');
var request	= require('request');
var vucoin	= require('vucoin');
var ucp     = require('../../../app/lib/ucp');
var crypto	= require('../../../app/lib/crypto');
var rawer		= require('../../../app/lib/rawer');
var base58	= require('../../../app/lib/base58');

module.exports = function (uid, salt, passwd, url) {
	return new User(uid, salt, passwd, url);
};

function User (uid, options, node) {

  var that = this;
  var pub, sec;
  var selfCert = "";

  // For sync code
  if (options.pub && options.sec) {
    pub = that.pub = options.pub;
    sec = base58.decode(options.sec);
  }

  function init(done) {
    if (options.salt && options.passwd) {
      async.waterfall([
        function (next) {
          crypto.getKeyPair(options.salt, options.passwd, next);
        },
        function (pair, next) {
          pub = that.pub = base58.encode(pair.publicKey);
          sec = pair.secretKey;
          next();
        }
      ], done);
    } else if (options.pub && options.sec) {
      pub = that.pub = options.pub;
      sec = base58.decode(options.sec);
      done();
    } else {
      throw 'Not keypair information given for testing user ' + uid;
    }
  }

  this.selfCert = function (useRoot) {
    return function(done) {
      async.waterfall([
        function(next) {
          if (!pub) {
            init(next);
          }
          else next();
        },
        function(next) {
          node.server.BlockchainService.current(next);
        },
        function(current, next) {
          let buid = !useRoot && current ? ucp.format.buid(current.number, current.hash) : '0-DA39A3EE5E6B4B0D3255BFEF95601890AFD80709';
          selfCert = rawer.getSelfIdentity({ buid: buid, uid: uid });
          selfCert += crypto.signSync(selfCert, sec);
          post('/wot/add', {
            "pubkey": pub,
            "self": selfCert
          }, next);
        }
      ], function(err) {
        done(err);
      });
    };
  };

  this.selfCertPromise = function(useRoot) {
    return Q.Promise(function(resolve, reject){
      that.selfCert(useRoot)(function(err) {
        err ? reject(err) : resolve();
      });
    });
  };

  this.certPromise = function(user) {
    return Q.Promise(function(resolve, reject){
      that.cert(user)(function(err) {
        err ? reject(err) : resolve();
      });
    });
  };

  this.cert = function (user) {
    return function(done) {
      async.waterfall([
        function(next) {
          async.parallel({
            lookup: lookup(user.pub, function(res, callback) {
              callback(null, res);
            }),
            current: function(callback){
              node.server.BlockchainService.current(callback);
            }
          }, next);
        },
        function(res, next) {
          var current = res.current;
          var idty = res.lookup.results[0].uids[0];
          var hisPub = res.lookup.results[0].pubkey;
          selfCert = rawer.getSelfIdentity({ buid: idty.meta.timestamp, uid: idty.uid });
          selfCert += idty.self;
          var blockNumber = (current ? current.number : 0);
          let buid = current ? ucp.format.buid(current.number, current.hash) : ucp.format.buid();
          var cert = selfCert + '\nMETA:TS:' + buid + '\n';
          var sig = crypto.signSync(cert, sec);
          post('/wot/add', {
            "pubkey": hisPub,
            "self": selfCert,
            "other": [pub, hisPub, blockNumber, sig].join(':') + '\n'
          }, next);
        }
      ], function(err) {
        done(err);
      });
    }
  };

  this.join = function () {
    return that.sendMembership("IN");
  };

  this.joinPromise = function () {
    return that.sendMembershipPromise("IN");
  };

  this.leave = function () {
    return that.sendMembership("OUT");
  };

  this.sendMembershipPromise = function(type) {
    return Q.nfcall(that.sendMembership(type));
  };

  this.sendMembership = function (type) {
    return function(done) {
      async.waterfall([
        function(next) {
          async.parallel({
            lookup: lookup(pub, function(res, callback) {
              callback(null, res);
            }),
            current: function(callback){
              node.server.BlockchainService.current(callback);
            }
          }, next);
        },
        function(res, next) {
          var current = res.current;
          var idty = res.lookup.results[0].uids[0];
          var block = ucp.format.buid(current);
          var join = rawer.getMembershipWithoutSignature({
            "version": 1,
            "currency": node.server.conf.currency,
            "issuer": pub,
            "block": block,
            "membership": type,
            "userid": uid,
            "certts": idty.meta.timestamp
          });
          var sig = crypto.signSync(join, sec);
          post('/blockchain/membership', {
            "membership": join + sig + '\n'
          }, next);
        }
      ], function(err) {
        done(err);
      });
    }
  };

  this.send = function (amount, recipient, comment) {
    return function(done) {
      var sources = [];
      var choices = {};
      var currency = '';
      var raw = "";
      async.waterfall([
        function (next) {
          if (!amount || !recipient) {
            next('Amount and recipient are required');
            return;
          }
          getVucoin()
            .then(function(http){
              http.tx.sources(pub, next);
            })
            .catch(next);
        },
        function (json, next) {
          currency = json.currency;
          var i = 0;
          var cumulated = 0;
          while (i < json.sources.length) {
            var src = json.sources[i];
            sources.push({
              'type': src.type,
              'amount': src.amount,
              'number': src.number,
              'hash': src.fingerprint
            });
            cumulated += src.amount;
            i++;
          }
          if (cumulated < amount) {
            next('You do not have enough coins! (' + cumulated + ' ' + currency + ' left)');
          }
          else {
            next();
          }
        },
        function (next) {
          var selected = [];
          var total = 0;
          for (var i = 0; i < sources.length && total < amount; i++) {
            var src = sources[i];
            total += src.amount;
            selected.push(src);
          }
          next(null, selected);
        },
        function (sources, next) {
          var inputSum = 0;
          var issuer = pub;
          raw += "Version: 1" + '\n';
          raw += "Type: Transaction\n";
          raw += "Currency: " + currency + '\n';
          raw += "Issuers:\n";
          raw += issuer + '\n';
          raw += "Inputs:\n";
          sources.forEach(function (src) {
            raw += ['0', src.type, src.number, src.hash, src.amount].join(':') + '\n';
            inputSum += src.amount;
          });
          raw += "Outputs:\n";
          raw += [recipient.pub, amount].join(':') + '\n';
          if (inputSum - amount > 0) {
            // Rest back to issuer
            raw += [issuer, inputSum - amount].join(':') + '\n';
          }
          raw += "Comment: " + (comment || "") + "\n";
          next(null, raw);
        },
        function (raw, next) {
          var sig = crypto.signSync(raw, sec);
          raw += sig + '\n';

          getVucoin()
            .then(function(http){
              http.tx.process(raw, function (err) {
                if (err) console.error('Error:', err);
                next(err);
              })
            })
            .catch(next);
        }
      ], done);
    }
  };

  function post(uri, data, done) {
    console.log(data);
    var postReq = request.post({
      "uri": 'http://' + [node.server.conf.remoteipv4, node.server.conf.remoteport].join(':') + uri,
      "timeout": 1000*100000
    }, function (err, res, body) {
      err = err || (res.statusCode != 200 && body != 'Already up-to-date' && body) || null;
      done(err, res, body);
    });
    postReq.form(data);
  }

  function getVucoin() {
    return Q.Promise(function(resolve, reject){
      vucoin(node.server.conf.ipv4, node.server.conf.port, function(err, node) {
        if (err) return reject(err);
        resolve(node);
      }, {
        timeout: 1000*100000
      });
    });
  }

  function lookup(pubkey, done) {
    return function(calback) {
      getVucoin()
        .then(function(node){
          node.wot.lookup(pubkey, function(err, res) {
            if (err) {
              console.error(err);
            }
            done(res, calback);
          });
        })
        .catch(done);
    };
  }

  this.selfCertP = (when) => Q.nfcall(this.selfCert(when));
  this.certP = (user) => Q.nfcall(this.cert(user));
  this.joinP = () => Q.nfcall(this.join());
  this.leaveP = () => Q.nfcall(this.leave());
  this.sendP = (amount, userid, comment) => Q.nfcall(this.send.apply(this, [amount, userid, comment]));
}
