var mysql = require('mysql');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var generateBinlog = require('./lib/sequence/binlog');

function ZongJi(dsn) {
  EventEmitter.call(this);

  // to send table info query
  this.ctrlConnection = mysql.createConnection({
    host: dsn.host,
    user: dsn.user,
    password: dsn.password,
    database: 'information_schema',
  });
  this.ctrlConnection.connect();
  this.ctrlCallbacks = [];

  this.connection = mysql.createConnection(dsn);

  this.tableMap = {};
  this.ready = false;
  this.useChecksum = false;

  this._init();
}

util.inherits(ZongJi, EventEmitter);

ZongJi.prototype._init = function() {
  var self = this;

  this._isChecksumEnabled(function(checksumEnabled) {
    self.useChecksum = checksumEnabled;
    var options = {
      tableMap: self.tableMap,
      useChecksum: checksumEnabled,
    };

    self.binlog = generateBinlog(self.connection, options);
    self.ready = true;

    self._executeCtrlCallbacks();
  });
};

ZongJi.prototype._isChecksumEnabled = function(next) {
  var sql = 'select @@GLOBAL.binlog_checksum as checksum';
  var ctrlConnection = this.ctrlConnection;
  var connection = this.connection;

  ctrlConnection.query(sql, function(err, rows) {
    if (err) {
      if(err.toString().match(/ER_UNKNOWN_SYSTEM_VARIABLE/)){
        // MySQL < 5.6.2 does not support @@GLOBAL.binlog_checksum
        return next(false);
      }
      throw err;
    }

    var checksumEnabled = true;
    if (rows[0].checksum === 'NONE') {
      checksumEnabled = false;
    }

    var setChecksumSql = 'set @master_binlog_checksum=@@global.binlog_checksum';
    if (checksumEnabled) {
      connection.query(setChecksumSql, function(err) {
        if (err) {
          throw err;
        }
        next(checksumEnabled);
      });
    } else {
      next(checksumEnabled);
    }
  });
};

ZongJi.prototype._executeCtrlCallbacks = function() {
  if (this.ctrlCallbacks.length > 0) {
    this.ctrlCallbacks.forEach(function(cb) {
      setImmediate(cb);
    });
  }
};

var queryTemplate = 'SELECT ' +
  'COLUMN_NAME, COLLATION_NAME, CHARACTER_SET_NAME, ' +
  'COLUMN_COMMENT, COLUMN_TYPE ' +
  'FROM columns ' + 'WHERE table_schema="%s" AND table_name="%s"';

ZongJi.prototype._fetchTableInfo = function(tableMapEvent, next) {
  var sql = util.format(queryTemplate,
    tableMapEvent.schemaName, tableMapEvent.tableName);

  var self = this;

  this.ctrlConnection.query(sql, function(err, rows) {
    if (err) {
      throw err;
    }

    self.tableMap[tableMapEvent.tableId] = {
      columnSchemas: rows,
      parentSchema: tableMapEvent.schemaName,
      tableName: tableMapEvent.tableName
    };

    next();
  });
};

ZongJi.prototype.start = function(options) {
  var self = this;
  var connection = this.connection;

  var emitBinlog = function(binlog) {
    self.emit('binlog', binlog);
  };

  if (options && options.filter) {
    emitBinlog = function(binlog) {
      if (options.filter.indexOf(binlog.getEventName()) > -1) {
        self.emit('binlog', binlog);
      }
    };
  }

  var _start = function() {
    connection._implyConnect();
    connection._protocol._enqueue(new self.binlog(function(err, event) {
      if(err) throw err;
      if (event.getTypeName() === 'TableMap') {
        var tableMap = self.tableMap[event.tableId];

        if (!tableMap) {
          connection.pause();
          self._fetchTableInfo(event, function() {
            // merge the column info with metadata
            event.updateColumnInfo();
            emitBinlog(event);
            connection.resume();
          });
          return;
        }
      }

      emitBinlog(event);
    }));
  };

  if (this.ready) {
    _start();
  } else {
    this.ctrlCallbacks.push(_start);
  }
};

module.exports = ZongJi;
